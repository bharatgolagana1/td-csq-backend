import {
  Schema,
  model as registerModel,
  models,
  type AnyKeys,
  type Aggregate,
  type FilterQuery,
  type HydratedDocument,
  type Model,
  type MongooseDefaultQueryMiddleware,
  type PipelineStage,
  type ProjectionType,
  type Query,
  type QueryOptions,
  type SchemaDefinition,
  type UpdateQuery,
} from 'mongoose';
import { currentScope } from './requestContext.js';
import { fail, notFound } from './errors.js';
import { newId } from './ids.js';

/**
 * Tenancy is enforced here and nowhere else, because a rule that lives in each
 * handler is a rule that one handler will eventually skip. Every query path
 * Mongoose exposes is intercepted, including the document paths, because query
 * middleware does not fire on .save() and .save() is what SETS ownership.
 */

export const TENANT_KEY = 'orgId';

/** Fields the plugin owns. A module never writes these itself. */
export interface TenantFields {
  orgId: string;
}

type Enforcement = { readonly kind: 'ORG'; readonly orgId: string } | { readonly kind: 'SYSTEM' };

function enforcement(): Enforcement {
  const scope = currentScope();
  switch (scope.kind) {
    case 'ORG':
      return { kind: 'ORG', orgId: scope.orgId };
    case 'SYSTEM':
      return { kind: 'SYSTEM' };
    case 'NONE':
      throw fail('INTERNAL', 'Tenant-scoped collection reached outside an organisation scope');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A caller that named another organisation is answered as if the document did
 * not exist. It is a programming error rather than a request we should service,
 * but the shape of the refusal still matters: anything other than NOT_FOUND here
 * eventually becomes a 403 on a guessed id, which is an enumeration oracle.
 */
function assertSameOrg(declared: unknown, orgId: string): void {
  if (declared !== undefined && declared !== orgId) throw notFound('Not found');
}

function guardUpdate(update: unknown, orgId: string): void {
  if (!isRecord(update)) return;
  assertSameOrg(update[TENANT_KEY], orgId);
  for (const operator of ['$set', '$setOnInsert', '$unset', '$rename'] as const) {
    const clause = update[operator];
    if (isRecord(clause) && TENANT_KEY in clause) {
      if (operator === '$set' || operator === '$setOnInsert') {
        assertSameOrg(clause[TENANT_KEY], orgId);
      } else {
        throw fail('INTERNAL', `An update may not ${operator} ${TENANT_KEY}`);
      }
    }
  }
}

function applyToQuery(query: Query<unknown, unknown>): void {
  const scope = enforcement();
  if (scope.kind === 'SYSTEM') return;

  const filter = query.getFilter();
  assertSameOrg(filter[TENANT_KEY], scope.orgId);
  query.setQuery({ ...filter, [TENANT_KEY]: scope.orgId });

  const update = query.getUpdate();
  guardUpdate(update, scope.orgId);

  // an upsert that misses creates a document with no owner unless we stamp it
  if (query.getOptions().upsert === true && isRecord(update)) {
    const onInsert = isRecord(update['$setOnInsert']) ? update['$setOnInsert'] : {};
    query.setUpdate({ ...update, $setOnInsert: { ...onInsert, [TENANT_KEY]: scope.orgId } });
  }
}

function stampDocument(doc: HydratedDocument<unknown>): void {
  const scope = enforcement();
  if (scope.kind === 'SYSTEM') return;

  const current: unknown = doc.get(TENANT_KEY);
  if (current === undefined || current === null) {
    doc.set(TENANT_KEY, scope.orgId);
    return;
  }
  assertSameOrg(current, scope.orgId);
}

function applyToPipeline(pipeline: PipelineStage[]): void {
  const scope = enforcement();
  if (scope.kind === 'SYSTEM') return;
  // first stage, so no $lookup or $group can run over another tenant's documents
  pipeline.unshift({ $match: { [TENANT_KEY]: scope.orgId } });
}

const QUERY_HOOKS: MongooseDefaultQueryMiddleware[] = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'replaceOne',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
];

export interface TenancyPluginOptions {
  /** True for a collection that holds exactly one document per organisation. */
  readonly uniqueTenant?: boolean;
}

export function tenancyPlugin(schema: Schema, options?: TenancyPluginOptions): void {
  schema.add({
    orgId: {
      type: String,
      required: true,
      index: true,
      unique: options?.uniqueTenant === true,
      // ownership is decided once, at insert. Nothing may move a document
      // between organisations, least of all an update that looks harmless
      immutable: true,
    },
  });

  schema.pre<Query<unknown, unknown>>(QUERY_HOOKS, function (next) {
    try {
      applyToQuery(this);
      next();
    } catch (error) {
      next(error as Error);
    }
  });

  // estimatedDocumentCount reads collection metadata and cannot be filtered at
  // all, so it would answer with every tenant's row count. Refused outright.
  schema.pre<Query<unknown, unknown>>('estimatedDocumentCount', function (next) {
    next(fail('INTERNAL', 'estimatedDocumentCount cannot be tenant filtered. Use countDocuments.'));
  });

  schema.pre<HydratedDocument<unknown>>(['validate', 'save'], function (next) {
    try {
      stampDocument(this);
      next();
    } catch (error) {
      next(error as Error);
    }
  });

  schema.pre<Aggregate<unknown[]>>('aggregate', function (next) {
    try {
      applyToPipeline(this.pipeline());
      next();
    } catch (error) {
      next(error as Error);
    }
  });

  schema.pre<Model<unknown>>('insertMany', function (next, docs: unknown) {
    try {
      const scope = enforcement();
      if (scope.kind === 'ORG') {
        for (const doc of Array.isArray(docs) ? docs : [docs]) {
          if (!isRecord(doc)) continue;
          assertSameOrg(doc[TENANT_KEY], scope.orgId);
          doc[TENANT_KEY] = scope.orgId;
        }
      }
      next();
    } catch (error) {
      next(error as Error);
    }
  });

  schema.pre<Model<unknown>>('bulkWrite', function (next, ops: unknown[]) {
    try {
      const scope = enforcement();
      if (scope.kind === 'ORG') {
        for (const op of ops) applyToBulkOp(op, scope.orgId);
      }
      next();
    } catch (error) {
      next(error as Error);
    }
  });
}

function applyToBulkOp(op: unknown, orgId: string): void {
  if (!isRecord(op)) return;

  const insert = op['insertOne'];
  if (isRecord(insert) && isRecord(insert['document'])) {
    const document = insert['document'];
    assertSameOrg(document[TENANT_KEY], orgId);
    document[TENANT_KEY] = orgId;
  }

  for (const key of ['updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany'] as const) {
    const clause = op[key];
    if (!isRecord(clause)) continue;

    const filter = isRecord(clause['filter']) ? clause['filter'] : {};
    assertSameOrg(filter[TENANT_KEY], orgId);
    clause['filter'] = { ...filter, [TENANT_KEY]: orgId };

    if (key === 'replaceOne' && isRecord(clause['replacement'])) {
      const replacement = clause['replacement'];
      assertSameOrg(replacement[TENANT_KEY], orgId);
      replacement[TENANT_KEY] = orgId;
    }

    if (key === 'updateOne' || key === 'updateMany') {
      const update = clause['update'];
      guardUpdate(update, orgId);
      if (clause['upsert'] === true && isRecord(update)) {
        const onInsert = isRecord(update['$setOnInsert']) ? update['$setOnInsert'] : {};
        clause['update'] = { ...update, $setOnInsert: { ...onInsert, [TENANT_KEY]: orgId } };
      }
    }
  }
}

/**
 * The only supported way to declare a tenant-scoped collection. Building a
 * Schema by hand and forgetting the plugin is the failure this removes.
 */
export function defineTenantModel<TDoc>(args: {
  name: string;
  definition: SchemaDefinition;
  /** One document per organisation, e.g. a settings document. */
  uniqueTenant?: boolean;
  /** Indexes and hooks the collection needs. Runs before the model is compiled. */
  configure?: (schema: Schema<TDoc & TenantFields, Model<TDoc & TenantFields>>) => void;
}): Model<TDoc & TenantFields> {
  // a model compiled twice in one process is a reload or a second test file,
  // not a second collection
  const already = models[args.name];
  if (already) return already as Model<TDoc & TenantFields>;

  const schema = new Schema<TDoc & TenantFields, Model<TDoc & TenantFields>>(
    { _id: { type: String, default: newId }, ...args.definition } as SchemaDefinition,
    { timestamps: true },
  );
  schema.plugin(tenancyPlugin, { uniqueTenant: args.uniqueTenant === true });
  args.configure?.(schema);
  return registerModel<TDoc & TenantFields>(args.name, schema);
}

/**
 * Filters and updates that cannot mention the tenant key.
 *
 * Making orgId `never` means a handler that tries to "just pass the org through"
 * does not compile, so the plugin stays the only thing that decides what a query
 * is allowed to see.
 */
export type TenantFilter<TDoc> = FilterQuery<TDoc> & { orgId?: never };
export type TenantUpdate<TDoc> = UpdateQuery<TDoc> & {
  orgId?: never;
  $set?: { orgId?: never };
  $setOnInsert?: { orgId?: never };
};
/** Schema defaults fill in whatever a draft leaves out. orgId is never one of them. */
export type TenantDraft<TDoc> = Partial<Omit<TDoc, 'orgId'>> & { orgId?: never };

export class TenantRepo<TDoc> {
  constructor(private readonly model: Model<TDoc & TenantFields>) {}

  /** Escape hatch for index management and migrations. Never for request work. */
  get collectionName(): string {
    return this.model.collection.name;
  }

  find(
    filter: TenantFilter<TDoc> = {} as TenantFilter<TDoc>,
    projection?: ProjectionType<TDoc & TenantFields>,
    options?: QueryOptions<TDoc & TenantFields>,
  ) {
    return this.model.find(filter as FilterQuery<TDoc & TenantFields>, projection, options);
  }

  findOne(filter: TenantFilter<TDoc>, projection?: ProjectionType<TDoc & TenantFields>) {
    return this.model.findOne(filter as FilterQuery<TDoc & TenantFields>, projection);
  }

  findById(id: string) {
    return this.model.findOne({ _id: id } as FilterQuery<TDoc & TenantFields>);
  }

  async create(draft: TenantDraft<TDoc>): Promise<HydratedDocument<TDoc & TenantFields>> {
    const doc = new this.model(draft as AnyKeys<TDoc & TenantFields>);
    await doc.save();
    return doc;
  }

  async updateOne(
    filter: TenantFilter<TDoc>,
    update: TenantUpdate<TDoc>,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const result = await this.model
      .updateOne(filter as FilterQuery<TDoc & TenantFields>, update as UpdateQuery<TDoc & TenantFields>)
      .exec();
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  findOneAndUpdate(
    filter: TenantFilter<TDoc>,
    update: TenantUpdate<TDoc>,
    options?: QueryOptions<TDoc & TenantFields>,
  ) {
    return this.model.findOneAndUpdate(
      filter as FilterQuery<TDoc & TenantFields>,
      update as UpdateQuery<TDoc & TenantFields>,
      { new: true, ...options },
    );
  }

  async deleteOne(filter: TenantFilter<TDoc>): Promise<{ deletedCount: number }> {
    const result = await this.model.deleteOne(filter as FilterQuery<TDoc & TenantFields>).exec();
    return { deletedCount: result.deletedCount };
  }

  async countDocuments(filter: TenantFilter<TDoc> = {} as TenantFilter<TDoc>): Promise<number> {
    return this.model.countDocuments(filter as FilterQuery<TDoc & TenantFields>).exec();
  }

  aggregate<TResult>(pipeline: PipelineStage[]): Aggregate<TResult[]> {
    return this.model.aggregate<TResult>(pipeline);
  }
}
