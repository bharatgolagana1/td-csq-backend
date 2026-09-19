import { z } from 'zod';
import { AssessorKind, Direction, FormScope, RatingKey, Ulid } from '@csq/contracts';

/**
 * Everything scoring reads but does not own.
 *
 * A scoring run is downstream of four modules: cycles owns the windows and the
 * participations, assessments owns the returns and the instrument they were
 * answered against, refdata owns the categories, the weighting profiles, the
 * airports and the market shares, and orgs owns who the operator is.
 *
 * The shapes below are transcribed from those modules' own documents, and every
 * document is validated against them on the way in. A field renamed upstream
 * becomes a loud failure naming the collection and the field at the moment of
 * the run, rather than a rating that is quietly wrong. Reconciling is an edit to
 * this one file, and `ScoringSources` lets a module hand scoring its own
 * repository later without the arithmetic knowing.
 */

export const INPUT_COLLECTIONS = {
  cycles: 'cycles',
  participations: 'cycleparticipations',
  assessments: 'assessments',
  instruments: 'assessmentinstruments',
  categories: 'refcategories',
  weightingProfiles: 'weightingprofiles',
  airports: 'airports',
  marketShares: 'marketsharesnapshots',
  organisations: 'organizations',
} as const;

const StoredBoundary = z.object({
  wall: z.string().min(1),
  tz: z.string().min(1),
  /** The only field arithmetic uses. Stored resolved, so scoring resolves no zones. */
  utc: z.coerce.date(),
});

/**
 * The cycle's own state machine is deliberately not read. Scoring needs to know
 * whether the assessment window has closed, and the windows answer that through
 * the core predicates, so a new member of the cycle state enum cannot change
 * what a score means.
 */
export const CycleInput = z.object({
  _id: Ulid,
  name: z.string().min(1),
  formScope: FormScope,
  windows: z.object({
    samplingOpens: StoredBoundary,
    samplingCloses: StoredBoundary,
    assessmentOpens: StoredBoundary,
    assessmentCloses: StoredBoundary,
  }),
});
export type CycleInput = z.infer<typeof CycleInput>;

/** The unit being scored: one operator, at one airport, in one cycle. */
export const ParticipationInput = z.object({
  _id: Ulid,
  cycleId: Ulid,
  /** The assessed operator's organisation. It becomes the rollup's tenant. */
  acoOrgId: Ulid,
  airportId: Ulid.nullable().default(null),
  formScope: FormScope,
  // read as a string rather than an enum: scoring cares about one member of it,
  // and a state added upstream must not stop a cycle from being scored
  state: z.string().min(1),
});
export type ParticipationInput = z.infer<typeof ParticipationInput>;

export const WITHDRAWN_PARTICIPATION_STATE = 'WITHDRAWN';
export const SUBMITTED_ASSESSMENT_STATE = 'SUBMITTED';
export const PUBLISHED_PROFILE_STATE = 'PUBLISHED';

const AnswerInput = z.object({
  questionCode: z.string().min(1),
  ratings: z.array(z.object({ direction: Direction, rating: RatingKey })).default([]),
});

export const AssessmentInput = z.object({
  _id: Ulid,
  cycleId: Ulid,
  acoOrgId: Ulid,
  /** Set when an operator runs more than one terminal in the same cycle. */
  participationId: Ulid.nullable().default(null),
  assessorKind: AssessorKind,
  formScope: FormScope,
  /** The exact instrument this assessor answered. Not assumed, recorded. */
  instrumentId: z.string().min(1),
  state: z.string().min(1),
  answers: z.array(AnswerInput).default([]),
});
export type AssessmentInput = z.infer<typeof AssessmentInput>;

export const QuestionInput = z.object({
  code: z.string().min(1),
  categoryCode: z.string().min(1),
  answerType: z.enum(['RATING_5', 'TEXT', 'SINGLE_SELECT']),
  weightBp: z.number().int().min(0).max(10_000),
  scored: z.boolean(),
  applicableDirections: z.array(Direction),
});

export const InstrumentInput = z.object({
  _id: z.string().min(1),
  code: z.string().min(1),
  version: z.number().int().min(1),
  formScope: FormScope,
  /** Which published bank this instrument was cut from, when it says. */
  sourceRef: z.string().min(1).nullable().default(null),
  questions: z.array(QuestionInput).min(1),
});
export type InstrumentInput = z.infer<typeof InstrumentInput>;

const Bp = z.number().int().min(0).max(10_000);

const ScopeWeights = z.object({
  /** Category code to basis points, summing to 10000 across the scope. */
  categories: z.record(z.string(), Bp).default({}),
  /** Question code to basis points, summing to 10000 within each category. */
  questions: z.record(z.string(), Bp).default({}),
});

export const WeightingProfileInput = z.object({
  _id: z.string().min(1),
  code: z.string().min(1),
  version: z.number().int().min(1),
  basis: z.enum(['EQUAL', 'CONFIGURED']),
  state: z.string().min(1),
  snapshotId: z.string().min(1).nullable().default(null),
  weights: z
    .object({ INTERNATIONAL: ScopeWeights.default({}), DOMESTIC: ScopeWeights.default({}) })
    .default({}),
});
export type WeightingProfileInput = z.infer<typeof WeightingProfileInput>;

/** Category display names. The instrument carries codes; refdata carries the words. */
export const CategoryInput = z.object({
  _id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  displayOrder: z.number().int().min(0).default(0),
});
export type CategoryInput = z.infer<typeof CategoryInput>;

export const AirportInput = z.object({
  _id: z.string().min(1),
  iataCode: z.string().min(2).max(4),
  /** The airport's full name, e.g. Chhatrapati Shivaji Maharaj International. */
  name: z.string().min(1),
  /** The city, which is what a ranking table shows. */
  city: z.string().min(1).nullable().default(null),
});
export type AirportInput = z.infer<typeof AirportInput>;

/**
 * Published shares for the operators at one airport. Scoring never derives
 * these: where ACFI has not published a snapshot, the market share stage stays
 * off and two terminals at one airport are their own mean.
 */
export const MarketShareSnapshotInput = z.object({
  _id: z.string().min(1),
  airportId: z.string().min(1),
  lines: z
    .array(
      z.object({
        orgId: z.string().min(1).nullable().default(null),
        shareBp: Bp,
      }),
    )
    .default([]),
  effectiveFrom: z.coerce.date(),
});
export type MarketShareSnapshotInput = z.infer<typeof MarketShareSnapshotInput>;

export const OrganisationInput = z.object({
  _id: z.string().min(1),
  legalName: z.string().min(1),
  displayName: z.string().min(1).nullable().default(null),
});
export type OrganisationInput = z.infer<typeof OrganisationInput>;

/**
 * What a scoring run needs from the rest of the system. The Mongo implementation
 * is in scoring.sources.ts; a module that owns one of these collections can
 * supply its own repository without the pipeline knowing.
 */
export interface ScoringSources {
  cycle(cycleId: string): Promise<CycleInput | null>;
  participations(cycleId: string): Promise<ParticipationInput[]>;
  submittedAssessments(cycleId: string, acoOrgId: string): Promise<AssessmentInput[]>;
  instruments(instrumentIds: readonly string[]): Promise<Map<string, InstrumentInput>>;
  /** Fallback for a cycle whose participants have not returned anything yet. */
  latestInstrument(formScope: z.infer<typeof FormScope>): Promise<InstrumentInput | null>;
  publishedProfiles(): Promise<WeightingProfileInput[]>;
  categories(): Promise<Map<string, CategoryInput>>;
  airports(airportIds: readonly string[]): Promise<Map<string, AirportInput>>;
  /** Latest snapshot per airport, or no entry where none is published. */
  marketShares(airportIds: readonly string[]): Promise<Map<string, MarketShareSnapshotInput>>;
  organisations(orgIds: readonly string[]): Promise<Map<string, OrganisationInput>>;
}
