import { Schema, model, models, type Model } from 'mongoose';
import { Direction, FormScope, RatingKey, ScoreEnvelope } from '@csq/contracts';
import { defineTenantModel, type TenantFields } from '../../kernel/tenancy.js';
import { newId } from '../../kernel/ids.js';

/**
 * Two kinds of collection, for two different readers.
 *
 * A rollup belongs to the operator it describes, so it is tenant scoped and the
 * dashboard is an ordinary filtered read. The cohort snapshot is the league
 * table the programme publishes to every participant, which no single
 * organisation owns, so it deliberately sits outside tenancy the way the kernel's
 * own identity collections do. It holds only figures every participant is shown,
 * and the service projects the identifiers away before anything is returned.
 */

const SUPPRESSIONS = [...ScoreEnvelope.shape.suppression.options];
export type Suppression = ScoreEnvelope['suppression'];

export type RollupMode = 'PROVISIONAL' | 'FINAL';
export const ROLLUP_MODES: readonly RollupMode[] = ['PROVISIONAL', 'FINAL'];

/** The three states the dashboard renders, derived from the windows, never stored upstream. */
export type CycleDisplayState = 'OPEN' | 'CLOSED' | 'SCORED';

export interface StoredScore {
  value: number | null;
  coverageBp: number;
  responseCount: number;
  suppression: Suppression;
}

const scoreFields = {
  // null here is always explained by the suppression beside it
  value: { type: Number, default: null },
  coverageBp: { type: Number, required: true, default: 0 },
  responseCount: { type: Number, required: true, default: 0 },
  suppression: { type: String, enum: SUPPRESSIONS, required: true },
};

export interface StoredCategoryScore extends StoredScore {
  categoryCode: string;
  label: string;
  parameterCount: number;
}

const CategoryScoreSchema = new Schema<StoredCategoryScore>(
  {
    categoryCode: { type: String, required: true },
    label: { type: String, required: true },
    parameterCount: { type: Number, required: true, default: 0 },
    ...scoreFields,
  },
  { _id: false },
);

export interface StoredDirectionScore extends StoredScore {
  direction: Direction;
}

const DirectionScoreSchema = new Schema<StoredDirectionScore>(
  { direction: { type: String, enum: [...Direction.options], required: true }, ...scoreFields },
  { _id: false },
);

export interface StoredSelfScore {
  value: number | null;
  coverageBp: number;
  responseCount: number;
  categories: Array<{ categoryCode: string; value: number }>;
}

const SelfScoreSchema = new Schema<StoredSelfScore>(
  {
    value: { type: Number, default: null },
    coverageBp: { type: Number, required: true, default: 0 },
    responseCount: { type: Number, required: true, default: 0 },
    categories: {
      type: [new Schema({ categoryCode: { type: String, required: true }, value: { type: Number, required: true } }, { _id: false })],
      default: [],
    },
  },
  { _id: false },
);

export interface CycleRollupDoc {
  _id: string;
  cycleId: string;
  participationId: string;
  airportId: string | null;
  formScope: FormScope;
  mode: RollupMode;
  cycle: { label: string; state: CycleDisplayState };
  terminal: {
    terminalName: string;
    airportIata: string;
    airportName: string;
    airportFullName: string;
  };
  counts: { self: number; customer: number; external: number; total: number };
  overall: StoredScore;
  categories: StoredCategoryScore[];
  directions: StoredDirectionScore[];
  distribution: Array<{ key: RatingKey; count: number; percent: number }>;
  /** Reported back to the operator. Never published, never ranked, never shared. */
  self: StoredSelfScore;
  gap: { overall: number | null; categories: Array<{ categoryCode: string; value: number }> };
  /** Stored in full, so a published figure can be recomputed without trusting the profile to be immutable. */
  weighting: {
    profileId: string;
    version: number;
    basis: 'EQUAL' | 'CONFIGURED';
    categoryWeightBp: Array<{ categoryCode: string; weightBp: number }>;
  };
  instrument: { snapshotId: string; version: number; questionCount: number };
  marketShareApplied: boolean;
  rank: number | null;
  rankOf: number;
  pipelineVersion: string;
  computedAt: Date;
  frozenAt: Date | null;
}

export const CycleRollupModel = defineTenantModel<CycleRollupDoc>({
  name: 'CycleRollup',
  definition: {
    cycleId: { type: String, required: true },
    participationId: { type: String, required: true },
    airportId: { type: String, default: null },
    formScope: { type: String, enum: [...FormScope.options], required: true },
    mode: { type: String, enum: [...ROLLUP_MODES], required: true },
    cycle: {
      label: { type: String, required: true },
      state: { type: String, enum: ['OPEN', 'CLOSED', 'SCORED'], required: true },
    },
    terminal: {
      terminalName: { type: String, required: true },
      airportIata: { type: String, required: true },
      airportName: { type: String, required: true },
      airportFullName: { type: String, required: true },
    },
    counts: {
      self: { type: Number, required: true, default: 0 },
      customer: { type: Number, required: true, default: 0 },
      external: { type: Number, required: true, default: 0 },
      total: { type: Number, required: true, default: 0 },
    },
    overall: { type: new Schema<StoredScore>(scoreFields, { _id: false }), required: true },
    categories: { type: [CategoryScoreSchema], default: [] },
    directions: { type: [DirectionScoreSchema], default: [] },
    distribution: {
      type: [
        new Schema(
          {
            key: { type: String, enum: [...RatingKey.options], required: true },
            count: { type: Number, required: true },
            percent: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    self: { type: SelfScoreSchema, required: true },
    gap: {
      overall: { type: Number, default: null },
      categories: {
        type: [new Schema({ categoryCode: { type: String, required: true }, value: { type: Number, required: true } }, { _id: false })],
        default: [],
      },
    },
    weighting: {
      profileId: { type: String, required: true },
      version: { type: Number, required: true },
      basis: { type: String, enum: ['EQUAL', 'CONFIGURED'], required: true },
      categoryWeightBp: {
        type: [new Schema({ categoryCode: { type: String, required: true }, weightBp: { type: Number, required: true } }, { _id: false })],
        default: [],
      },
    },
    instrument: {
      snapshotId: { type: String, required: true },
      version: { type: Number, required: true },
      questionCount: { type: Number, required: true, default: 0 },
    },
    marketShareApplied: { type: Boolean, required: true, default: false },
    // written only by a freeze: a rank that exists while the window is open is a
    // cherry picking signal, so there is nothing to read during one
    rank: { type: Number, default: null },
    rankOf: { type: Number, required: true, default: 0 },
    pipelineVersion: { type: String, required: true },
    computedAt: { type: Date, required: true },
    frozenAt: { type: Date, default: null },
  },
  configure: (schema: Schema<CycleRollupDoc & TenantFields>) => {
    schema.index({ orgId: 1, cycleId: 1, participationId: 1 }, { unique: true });
    schema.index({ orgId: 1, computedAt: -1 });
    // the freeze writes back across organisations, keyed by cycle
    schema.index({ cycleId: 1, participationId: 1 });
  },
});

/**
 * Registers a collection that is deliberately not tenant scoped, and says so at
 * the point of definition. The guard against a double registration is the same
 * one defineTenantModel makes, because a reload or a second test file compiling
 * the module twice is not a second collection.
 */
function defineSharedModel<TDoc>(name: string, schema: Schema<TDoc>): Model<TDoc> {
  const already = models[name];
  if (already) return already as Model<TDoc>;
  return model<TDoc>(name, schema);
}

export interface CohortAirportRow {
  airportId: string | null;
  airportIata: string;
  airportName: string;
  airportFullName: string;
  terminalName: string;
  terminalCount: number;
  rating: number | null;
  rank: number | null;
  responseCount: number;
  /** Used only to answer "is this row the caller", and never serialised out. */
  orgIds: string[];
}

export interface CohortSnapshotDoc {
  _id: string;
  cycleId: string;
  cycleLabel: string;
  frozenAt: Date;
  frozenByUserId: string;
  frozenByOrgId: string;
  marketShare: { mode: 'OFF' | 'AIRPORT_ROLLUP'; applied: boolean };
  statistics: {
    count: number;
    mean: number;
    median: number;
    p25: number;
    p75: number;
    min: number;
    max: number;
  } | null;
  totalAirports: number;
  rankedCount: number;
  airports: CohortAirportRow[];
  weighting: { profileId: string; version: number };
  pipelineVersion: string;
}

const CohortAirportSchema = new Schema<CohortAirportRow>(
  {
    airportId: { type: String, default: null },
    airportIata: { type: String, required: true },
    airportName: { type: String, required: true },
    airportFullName: { type: String, required: true },
    terminalName: { type: String, required: true },
    terminalCount: { type: Number, required: true, default: 1 },
    rating: { type: Number, default: null },
    rank: { type: Number, default: null },
    responseCount: { type: Number, required: true, default: 0 },
    orgIds: { type: [String], default: [] },
  },
  { _id: false },
);

const CohortSnapshotSchema = new Schema<CohortSnapshotDoc>(
  {
    _id: { type: String, default: newId },
    cycleId: { type: String, required: true, unique: true },
    cycleLabel: { type: String, required: true },
    frozenAt: { type: Date, required: true },
    frozenByUserId: { type: String, required: true },
    frozenByOrgId: { type: String, required: true },
    marketShare: {
      mode: { type: String, enum: ['OFF', 'AIRPORT_ROLLUP'], required: true },
      applied: { type: Boolean, required: true, default: false },
    },
    statistics: {
      type: new Schema(
        {
          count: { type: Number, required: true },
          mean: { type: Number, required: true },
          median: { type: Number, required: true },
          p25: { type: Number, required: true },
          p75: { type: Number, required: true },
          min: { type: Number, required: true },
          max: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    totalAirports: { type: Number, required: true, default: 0 },
    rankedCount: { type: Number, required: true, default: 0 },
    airports: { type: [CohortAirportSchema], default: [] },
    weighting: {
      profileId: { type: String, required: true },
      version: { type: Number, required: true },
    },
    pipelineVersion: { type: String, required: true },
  },
  { timestamps: true },
);

export const CohortSnapshotModel = defineSharedModel<CohortSnapshotDoc>(
  'CohortSnapshot',
  CohortSnapshotSchema,
);

export interface ScoringRunDoc {
  _id: string;
  cycleId: string;
  mode: RollupMode;
  requestedByUserId: string;
  requestedByOrgId: string;
  reason: string;
  startedAt: Date;
  finishedAt: Date | null;
  participationCount: number;
  publishedCount: number;
  suppressedCount: number;
  skippedScopeMismatch: number;
  failure: string | null;
}

const ScoringRunSchema = new Schema<ScoringRunDoc>(
  {
    _id: { type: String, default: newId },
    cycleId: { type: String, required: true },
    mode: { type: String, enum: [...ROLLUP_MODES], required: true },
    requestedByUserId: { type: String, required: true },
    requestedByOrgId: { type: String, required: true },
    reason: { type: String, required: true },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    participationCount: { type: Number, required: true, default: 0 },
    publishedCount: { type: Number, required: true, default: 0 },
    suppressedCount: { type: Number, required: true, default: 0 },
    skippedScopeMismatch: { type: Number, required: true, default: 0 },
    failure: { type: String, default: null },
  },
  { timestamps: true },
);

ScoringRunSchema.index({ cycleId: 1, startedAt: -1 });

/** An operations record of every run, including the ones that failed half way. */
export const ScoringRunModel = defineSharedModel<ScoringRunDoc>('ScoringRun', ScoringRunSchema);
