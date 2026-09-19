import { Schema, model as registerModel, models, type Model } from 'mongoose';
import { defineTenantModel, type TenantFields } from '../../kernel/tenancy.js';
import { currentScope } from '../../kernel/requestContext.js';
import { fail } from '../../kernel/errors.js';
import { newId } from '../../kernel/ids.js';
import { LIST_KINDS, type ListKind } from './settings.contracts.js';

/**
 * One document per area per owner, rather than one large settings document.
 *
 * It gives each area its own revision counter, so an administrator saving the
 * notifications area cannot make the organisation area look stale to whoever
 * has it open, and it means a new area needs no migration of anything already
 * stored.
 */

/** revision 0 is the absence of a document. A stored area always starts at 1. */
export interface AreaDoc {
  _id: string;
  areaKey: string;
  value: unknown;
  revision: number;
  /** Who saved it last. Null only for a write made by a worker, not a person. */
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const areaDefinition = {
  areaKey: { type: String, required: true },
  value: { type: Schema.Types.Mixed, required: true },
  revision: { type: Number, required: true, default: 1 },
  updatedBy: { type: String, default: null },
};

export type OrgAreaDoc = AreaDoc;

export const OrgSettingsAreaModel = defineTenantModel<OrgAreaDoc>({
  name: 'OrgSettingsArea',
  definition: areaDefinition,
  configure: (schema: Schema<OrgAreaDoc & TenantFields>) => {
    schema.index({ orgId: 1, areaKey: 1 }, { unique: true });
  },
});

/**
 * Models outside tenancy are declared here rather than through
 * defineTenantModel, because they are deliberately not organisation scoped: a
 * person's own preferences follow them into every organisation they belong to,
 * and the platform areas are one document for the whole platform. Applying the
 * tenancy plugin to either would demand an organisation these documents do not
 * have.
 */
function definePlainModel<TDoc>(name: string, schema: Schema<TDoc>): Model<TDoc> {
  const already = models[name];
  if (already) return already as Model<TDoc>;
  return registerModel<TDoc>(name, schema);
}

export interface UserAreaDoc extends AreaDoc {
  userId: string;
}

const UserAreaSchema = new Schema<UserAreaDoc>(
  {
    _id: { type: String, default: newId },
    userId: { type: String, required: true },
    ...areaDefinition,
  },
  { timestamps: true },
);
// a person has one set of personal settings, not one per organisation: the
// language they read in does not change because they switched terminals
UserAreaSchema.index({ userId: 1, areaKey: 1 }, { unique: true });

export const UserSettingsAreaModel = definePlainModel<UserAreaDoc>('UserSettingsArea', UserAreaSchema);

export type PlatformAreaDoc = AreaDoc;

const PlatformAreaSchema = new Schema<PlatformAreaDoc>(
  {
    _id: { type: String, default: newId },
    ...areaDefinition,
  },
  { timestamps: true },
);
PlatformAreaSchema.index({ areaKey: 1 }, { unique: true });

/**
 * Platform settings are never read or written from inside an organisation
 * scope. They belong to no organisation, so a handler that reached this
 * collection while acting for one terminal would be editing the settings of
 * every terminal in the country. The routes that serve them carry a principal
 * and no organisation; a worker enters a system scope with a recorded reason.
 */
function refuseInsideOrganisationScope(next: (error?: Error) => void): void {
  const scope = currentScope();
  if (scope.kind === 'ORG') {
    next(fail('INTERNAL', 'Platform settings are not reachable from an organisation scope'));
    return;
  }
  next();
}

PlatformAreaSchema.pre(
  ['find', 'findOne', 'findOneAndUpdate', 'updateOne', 'deleteOne', 'countDocuments'],
  function (next) {
    refuseInsideOrganisationScope(next);
  },
);
PlatformAreaSchema.pre(['validate', 'save'], function (next) {
  refuseInsideOrganisationScope(next);
});

export const PlatformSettingsAreaModel = definePlainModel<PlatformAreaDoc>(
  'PlatformSettingsArea',
  PlatformAreaSchema,
);

/**
 * The audit trail. Before and after are stored whole: a diff computed at write
 * time cannot be re-read against a schema that has since gained a field, and
 * the question an auditor asks is what the settings were, not what changed.
 */
export interface OrgAuditDoc {
  _id: string;
  areaKey: string;
  actorUserId: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export const OrgSettingsAuditModel = defineTenantModel<OrgAuditDoc>({
  name: 'OrgSettingsAudit',
  definition: {
    areaKey: { type: String, required: true },
    actorUserId: { type: String, default: null },
    before: { type: Schema.Types.Mixed, required: true },
    after: { type: Schema.Types.Mixed, required: true },
  },
  configure: (schema: Schema<OrgAuditDoc & TenantFields>) => {
    schema.index({ orgId: 1, areaKey: 1, createdAt: -1 });
  },
});

export interface UnscopedAuditDoc {
  _id: string;
  /** SELF entries belong to a person, GLOBAL entries to the platform. */
  scope: 'SELF' | 'GLOBAL';
  /** The user id for SELF, the constant below for GLOBAL. */
  subjectId: string;
  areaKey: string;
  actorUserId: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export const PLATFORM_SUBJECT = 'PLATFORM';

const UnscopedAuditSchema = new Schema<UnscopedAuditDoc>(
  {
    _id: { type: String, default: newId },
    scope: { type: String, enum: ['SELF', 'GLOBAL'], required: true },
    subjectId: { type: String, required: true },
    areaKey: { type: String, required: true },
    actorUserId: { type: String, default: null },
    before: { type: Schema.Types.Mixed, required: true },
    after: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
UnscopedAuditSchema.index({ scope: 1, subjectId: 1, areaKey: 1, createdAt: -1 });

export const UnscopedSettingsAuditModel = definePlainModel<UnscopedAuditDoc>(
  'UnscopedSettingsAudit',
  UnscopedAuditSchema,
);

export interface ListItemDoc {
  _id: string;
  kind: ListKind;
  label: string;
  /** Case folded label, so two administrators cannot create "Perishable" twice. */
  labelKey: string;
  colour: string | null;
  position: number;
  archived: boolean;
  archivedAt: Date | null;
}

export const ListItemModel = defineTenantModel<ListItemDoc>({
  name: 'SettingsListItem',
  definition: {
    kind: { type: String, enum: [...LIST_KINDS], required: true },
    label: { type: String, required: true },
    labelKey: { type: String, required: true },
    colour: { type: String, default: null },
    position: { type: Number, required: true, default: 0 },
    // entries are archived rather than deleted: historical records point at them
    archived: { type: Boolean, required: true, default: false },
    archivedAt: { type: Date, default: null },
  },
  configure: (schema: Schema<ListItemDoc & TenantFields>) => {
    schema.index({ orgId: 1, kind: 1, position: 1 });
    schema.index(
      { orgId: 1, kind: 1, labelKey: 1 },
      { unique: true, partialFilterExpression: { archived: false } },
    );
  },
});
