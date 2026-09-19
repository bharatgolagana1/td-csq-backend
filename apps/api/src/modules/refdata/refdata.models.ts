import {
  Schema,
  model as registerModel,
  models,
  type Model,
  type Query,
  type SchemaDefinition,
} from 'mongoose';
import { fail } from '../../kernel/errors.js';
import { newId } from '../../kernel/ids.js';
import { MARKET_SHARE_DERIVATIONS, type MarketShareDerivation, type SnapshotContent } from './refdata.contracts.js';

/**
 * These collections are global on purpose, and so they do NOT carry the tenancy
 * plugin. Airports, the ACFI instrument and the weights it is scored with are
 * the same rows for every organisation; stamping them with an orgId would mean
 * every operator scored against its own private copy of the standard, which is
 * the one thing a standard cannot do.
 *
 * The cost of that decision is that nothing here may hold tenant data. The one
 * collection that comes close, market_share_snapshots, names several operators'
 * commercial shares at one airport, which is why its routes are platform only
 * rather than readable by any member of any organisation.
 */

export interface GlobalModelOptions<TDoc> {
  name: string;
  definition: SchemaDefinition;
  /** Insert and find only. Every update and delete path is refused. */
  immutable?: boolean;
  /** Supplies the _id instead of a fresh ULID, for a content addressed collection. */
  ownsId?: boolean;
  configure?: (schema: Schema<TDoc, Model<TDoc>>) => void;
}

const MUTATING_HOOKS = [
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'replaceOne',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
] as const;

export function defineGlobalModel<TDoc>(args: GlobalModelOptions<TDoc>): Model<TDoc> {
  const already = models[args.name];
  if (already) return already as Model<TDoc>;

  const idField = args.ownsId === true ? { _id: { type: String, required: true } } : { _id: { type: String, default: newId } };
  const schema = new Schema<TDoc, Model<TDoc>>(
    { ...idField, ...args.definition } as SchemaDefinition,
    { timestamps: true },
  );

  if (args.immutable === true) {
    for (const hook of MUTATING_HOOKS) {
      schema.pre<Query<unknown, unknown>>(hook, function (next) {
        next(fail('INTERNAL', `${args.name} is append only: ${hook} is refused`));
      });
    }
    // an already persisted document must not be re-saved either, because
    // .save() does not go through query middleware
    schema.pre('save', function (next) {
      if (this.isNew) {
        next();
        return;
      }
      next(fail('INTERNAL', `${args.name} is append only: an existing document may not be saved again`));
    });
  }

  args.configure?.(schema);
  return registerModel<TDoc>(args.name, schema);
}

export interface RosterEntry {
  operatorKey: string;
  name: string;
  orgId: string | null;
  subscribed: boolean;
}

export interface AirportDoc {
  _id: string;
  iataCode: string;
  icaoCode: string | null;
  name: string;
  city: string | null;
  country: string;
  region: string;
  /** GeoJSON, so "airports within 200km" is an index lookup rather than a scan. */
  location: { type: 'Point'; coordinates: [number, number] };
  timezone: string;
  operatorRoster: RosterEntry[];
  isActive: boolean;
  /** Which dataset a seeded row came from, so a hand edit is visible as one. */
  source: { dataset: string; ident: string } | null;
  updatedAt: Date;
}

export const AirportModel = defineGlobalModel<AirportDoc>({
  name: 'Airport',
  definition: {
    iataCode: { type: String, required: true },
    icaoCode: { type: String, default: null },
    name: { type: String, required: true },
    city: { type: String, default: null },
    country: { type: String, required: true },
    region: { type: String, required: true },
    location: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    },
    timezone: { type: String, required: true },
    operatorRoster: {
      type: [
        new Schema<RosterEntry>(
          {
            operatorKey: { type: String, required: true },
            name: { type: String, required: true },
            orgId: { type: String, default: null },
            subscribed: { type: Boolean, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    isActive: { type: Boolean, required: true, default: true },
    source: {
      type: new Schema<{ dataset: string; ident: string }>(
        { dataset: { type: String, required: true }, ident: { type: String, required: true } },
        { _id: false },
      ),
      default: null,
    },
  },
  configure: (schema) => {
    schema.index({ iataCode: 1 }, { unique: true });
    // partial rather than sparse: a null stored explicitly is still a value, and
    // two airports awaiting an ICAO code would collide on a sparse index
    schema.index(
      { icaoCode: 1 },
      { unique: true, partialFilterExpression: { icaoCode: { $type: 'string' } } },
    );
    schema.index({ country: 1, region: 1, iataCode: 1 });
    schema.index({ 'operatorRoster.orgId': 1 });
    schema.index({ location: '2dsphere' });
  },
});

export interface CategoryDoc {
  _id: string;
  code: string;
  name: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
}

export const CategoryModel = defineGlobalModel<CategoryDoc>({
  name: 'RefCategory',
  definition: {
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    displayOrder: { type: Number, required: true },
    isActive: { type: Boolean, required: true, default: true },
  },
  configure: (schema) => {
    schema.index({ code: 1 }, { unique: true });
    schema.index({ displayOrder: 1 });
  },
});

export interface QuestionBankDoc {
  _id: string;
  code: string;
  title: string;
  description: string | null;
  sourceDocuments: string[];
}

export const QuestionBankModel = defineGlobalModel<QuestionBankDoc>({
  name: 'QuestionBank',
  definition: {
    code: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, default: null },
    sourceDocuments: { type: [String], default: [] },
  },
  configure: (schema) => schema.index({ code: 1 }, { unique: true }),
});

export const BANK_VERSION_STATES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type BankVersionState = (typeof BANK_VERSION_STATES)[number];

export interface QuestionBankVersionDoc {
  _id: string;
  bankCode: string;
  version: number;
  state: BankVersionState;
  /** Draft content. Frozen into a snapshot at publish and never read after. */
  questions: unknown[];
  notes: string | null;
  snapshotId: string | null;
  publishedAt: Date | null;
  publishedBy: string | null;
  updatedAt: Date;
}

export const QuestionBankVersionModel = defineGlobalModel<QuestionBankVersionDoc>({
  name: 'QuestionBankVersion',
  definition: {
    bankCode: { type: String, required: true },
    version: { type: Number, required: true },
    state: { type: String, enum: [...BANK_VERSION_STATES], required: true, default: 'DRAFT' },
    questions: { type: [Schema.Types.Mixed], default: [] },
    notes: { type: String, default: null },
    snapshotId: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: String, default: null },
  },
  configure: (schema) => {
    schema.index({ bankCode: 1, version: 1 }, { unique: true });
    // at most one published version per bank, enforced by the database rather
    // than by whichever handler happens to publish next
    schema.index(
      { bankCode: 1, state: 1 },
      { unique: true, partialFilterExpression: { state: 'PUBLISHED' } },
    );
  },
});

export interface SnapshotDoc {
  /** The content hash. A snapshot cannot exist twice under two identifiers. */
  _id: string;
  bankCode: string;
  /** The version that first froze this instrument. A later identical one reuses it. */
  firstVersion: number;
  content: SnapshotContent;
  createdAt: Date;
}

/**
 * Content addressed and append only. The identifier IS the hash of the
 * instrument, so a published bank cannot be edited underneath an assessment
 * that was already submitted against it: an edit produces a different hash,
 * which is a different document, and the old one is still there to score
 * against. The deployed database user for this collection should be granted
 * find and insert only; the hooks below are the in-process half of the same
 * rule, for the case where the process has a wider grant than it should.
 */
export const SnapshotModel = defineGlobalModel<SnapshotDoc>({
  name: 'QuestionBankSnapshot',
  immutable: true,
  ownsId: true,
  definition: {
    bankCode: { type: String, required: true },
    firstVersion: { type: Number, required: true },
    content: { type: Schema.Types.Mixed, required: true },
  },
  configure: (schema) => schema.index({ bankCode: 1, firstVersion: 1 }),
});

export const PROFILE_STATES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type ProfileState = (typeof PROFILE_STATES)[number];

export interface WeightingProfileDoc {
  _id: string;
  code: string;
  version: number;
  title: string;
  basis: 'EQUAL' | 'CONFIGURED';
  state: ProfileState;
  snapshotId: string;
  /** Scope to { categories, questions }, both keyed by code, in basis points. */
  weights: Record<string, { categories: Record<string, number>; questions: Record<string, number> }>;
  notes: string | null;
  publishedAt: Date | null;
  publishedBy: string | null;
  updatedAt: Date;
}

export const WeightingProfileModel = defineGlobalModel<WeightingProfileDoc>({
  name: 'WeightingProfile',
  definition: {
    code: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    title: { type: String, required: true },
    basis: { type: String, enum: ['EQUAL', 'CONFIGURED'], required: true },
    state: { type: String, enum: [...PROFILE_STATES], required: true, default: 'DRAFT' },
    snapshotId: { type: String, required: true },
    weights: { type: Schema.Types.Mixed, default: {} },
    notes: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: String, default: null },
  },
  configure: (schema) => {
    schema.index({ code: 1, version: 1 }, { unique: true });
    // one live profile per code, enforced by the database: two published
    // profiles under one code means a score cannot say which produced it
    schema.index(
      { code: 1, state: 1 },
      { unique: true, partialFilterExpression: { state: 'PUBLISHED' } },
    );
    schema.index({ snapshotId: 1, state: 1 });
  },
});

export interface MarketShareLine {
  orgId: string;
  operatorKey: string;
  operatorName: string;
  shareBp: number;
}

export interface MarketShareSnapshotDoc {
  _id: string;
  airportId: string;
  iataCode: string;
  derivation: MarketShareDerivation;
  /** The roster counts the derivation was read off, so the case is auditable. */
  operatorsAtAirport: number;
  subscribedOperators: number;
  lines: MarketShareLine[];
  effectiveFrom: Date;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/** Append only for the same reason a published score is: it is what was true then. */
export const MarketShareSnapshotModel = defineGlobalModel<MarketShareSnapshotDoc>({
  name: 'MarketShareSnapshot',
  immutable: true,
  definition: {
    airportId: { type: String, required: true },
    iataCode: { type: String, required: true },
    derivation: { type: String, enum: [...MARKET_SHARE_DERIVATIONS], required: true },
    operatorsAtAirport: { type: Number, required: true },
    subscribedOperators: { type: Number, required: true },
    lines: {
      type: [
        new Schema<MarketShareLine>(
          {
            orgId: { type: String, required: true },
            operatorKey: { type: String, required: true },
            operatorName: { type: String, required: true },
            shareBp: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      required: true,
    },
    effectiveFrom: { type: Date, required: true },
    note: { type: String, default: null },
    createdBy: { type: String, default: null },
  },
  configure: (schema) => {
    schema.index({ airportId: 1, effectiveFrom: -1 });
    schema.index({ 'lines.orgId': 1, effectiveFrom: -1 });
  },
});

export const REFDATA_MODELS = [
  AirportModel,
  CategoryModel,
  QuestionBankModel,
  QuestionBankVersionModel,
  SnapshotModel,
  WeightingProfileModel,
  MarketShareSnapshotModel,
] as const;
