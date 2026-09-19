import { z } from 'zod';
import { Direction, ScoreEnvelope, Ulid } from '@csq/contracts';

/**
 * The wire shapes scoring serves.
 *
 * DashboardData below is not a design decision made here: the dashboard page is
 * already built against it, so this is a transcription of
 * td-csq-frontend/src/app/features/dashboard/api/dashboard.types.ts, kept as a
 * zod schema so the response is validated against it before it is sent. A
 * rollup that drifts from what the page renders is caught by the API, not by a
 * blank card in a browser.
 */

/** The five published bands. NA never reaches a chart, because it is not a band. */
export const PublishedRatingKey = z.enum(['EXCELLENT', 'VERY_GOOD', 'GOOD', 'FAIR', 'POOR']);
export type PublishedRatingKey = z.infer<typeof PublishedRatingKey>;

export const Suppressible = z.object({
  /** null when the score is withheld rather than absent. */
  value: z.number().nullable(),
  suppression: ScoreEnvelope.shape.suppression,
});

export const CycleRatings = z.object({
  /** The operator's own assessment: reported back, never in the published score. */
  self: z.number().nullable(),
  /** The locked customer sample: what the rating is actually built from. */
  customer: z.number().nullable(),
});
export type CycleRatings = z.infer<typeof CycleRatings>;

export const CategoryRating = z.object({
  code: z.string(),
  label: z.string(),
  current: z.number().nullable(),
  previous: z.number().nullable(),
  /** current minus previous; null when there is no comparable prior cycle. */
  delta: z.number().nullable(),
  parameterCount: z.number().int().min(0),
});
export type CategoryRating = z.infer<typeof CategoryRating>;

export const RankingRow = z.object({
  rank: z.number().int().min(1),
  airportIata: z.string(),
  airportName: z.string(),
  terminalName: z.string(),
  rating: z.number().nullable(),
  /** The operator viewing the dashboard, highlighted in place. */
  isSelf: z.boolean(),
});
export type RankingRow = z.infer<typeof RankingRow>;

export const DashboardData = z.object({
  cycle: z.object({ id: z.string(), label: z.string(), state: z.enum(['OPEN', 'CLOSED', 'SCORED']) }),
  terminal: z.object({
    acoId: z.string(),
    terminalName: z.string(),
    airportIata: z.string(),
    airportName: z.string(),
    airportFullName: z.string(),
  }),
  overall: Suppressible.extend({
    rank: z.number().int().min(1).nullable(),
    rankOf: z.number().int().min(0),
    assessmentCount: z.number().int().min(0),
    selfCount: z.number().int().min(0),
    customerCount: z.number().int().min(0),
  }),
  ratings: z.object({ overall: CycleRatings, current: CycleRatings, previous: CycleRatings }),
  feedback: z.object({
    totalResponses: z.number().int().min(0),
    distribution: z.array(
      z.object({
        key: PublishedRatingKey,
        label: z.string(),
        count: z.number().int().min(0),
        percent: z.number().int().min(0).max(100),
      }),
    ),
  }),
  categories: z.array(CategoryRating),
  rankings: z.object({
    rows: z.array(RankingRow),
    totalAirports: z.number().int().min(0),
    footnote: z.string(),
  }),
});
export type DashboardData = z.infer<typeof DashboardData>;

/**
 * The detailed rollup, for anyone who needs to see why a figure is what it is.
 * Every score carries the coverage, the response count and the profile that
 * produced it, because a bare number cannot be checked.
 */
export const RollupView = z.object({
  cycleId: Ulid,
  cycleLabel: z.string(),
  participationId: Ulid,
  mode: z.enum(['PROVISIONAL', 'FINAL']),
  formScope: z.enum(['INTERNATIONAL', 'DOMESTIC']),
  terminal: z.object({
    terminalName: z.string(),
    airportIata: z.string(),
    airportName: z.string(),
    airportFullName: z.string(),
  }),
  counts: z.object({
    self: z.number().int().min(0),
    customer: z.number().int().min(0),
    external: z.number().int().min(0),
    total: z.number().int().min(0),
  }),
  overall: ScoreEnvelope,
  categories: z.array(ScoreEnvelope.extend({ categoryCode: z.string(), label: z.string(), parameterCount: z.number().int().min(0) })),
  directions: z.array(ScoreEnvelope.extend({ direction: Direction })),
  distribution: z.array(
    z.object({ key: PublishedRatingKey, count: z.number().int().min(0), percent: z.number().int().min(0).max(100) }),
  ),
  self: z.object({
    value: z.number().nullable(),
    coverageBp: z.number().int().min(0).max(10_000),
    responseCount: z.number().int().min(0),
  }),
  gap: z.object({
    overall: z.number().nullable(),
    categories: z.array(z.object({ categoryCode: z.string(), value: z.number() })),
  }),
  rank: z.number().int().min(1).nullable(),
  rankOf: z.number().int().min(0),
  // neither identifier is minted here, and refdata addresses a published
  // instrument by its content hash, so neither is assumed to be a ULID
  instrument: z.object({
    snapshotId: z.string().min(1),
    version: z.number().int(),
    questionCount: z.number().int(),
  }),
  weightingProfile: z.object({
    profileId: z.string().min(1),
    version: z.number().int(),
    basis: z.enum(['EQUAL', 'CONFIGURED']),
  }),
  pipelineVersion: z.string(),
  computedAt: z.string(),
  frozenAt: z.string().nullable(),
});
export type RollupView = z.infer<typeof RollupView>;

export const TrendPoint = z.object({
  cycleId: Ulid,
  cycleLabel: z.string(),
  computedAt: z.string(),
  customer: z.number().nullable(),
  self: z.number().nullable(),
  /** Self minus customer. The number the programme exists to surface. */
  gap: z.number().nullable(),
  suppression: ScoreEnvelope.shape.suppression,
  responseCount: z.number().int().min(0),
  rank: z.number().int().min(1).nullable(),
  rankOf: z.number().int().min(0),
});
export type TrendPoint = z.infer<typeof TrendPoint>;

export const TrendView = z.object({
  participationIds: z.array(Ulid),
  points: z.array(TrendPoint),
});
export type TrendView = z.infer<typeof TrendView>;

export const PerceptionGapView = z.object({
  cycleId: Ulid,
  cycleLabel: z.string(),
  overall: z.object({ self: z.number().nullable(), customer: z.number().nullable(), gap: z.number().nullable() }),
  categories: z.array(
    z.object({
      categoryCode: z.string(),
      label: z.string(),
      self: z.number().nullable(),
      customer: z.number().nullable(),
      gap: z.number().nullable(),
    }),
  ),
});
export type PerceptionGapView = z.infer<typeof PerceptionGapView>;

export const CohortView = z.object({
  cycleId: Ulid,
  cycleLabel: z.string(),
  frozenAt: z.string(),
  totalAirports: z.number().int().min(0),
  rankedCount: z.number().int().min(0),
  marketShareApplied: z.boolean(),
  statistics: z
    .object({
      count: z.number().int().min(0),
      mean: z.number(),
      median: z.number(),
      p25: z.number(),
      p75: z.number(),
      min: z.number(),
      max: z.number(),
    })
    .nullable(),
  rows: z.array(RankingRow.extend({ rank: z.number().int().min(1).nullable() })),
});
export type CohortView = z.infer<typeof CohortView>;

export const ScoringRunView = z.object({
  runId: Ulid,
  cycleId: Ulid,
  mode: z.enum(['PROVISIONAL', 'FINAL']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  participationCount: z.number().int().min(0),
  publishedCount: z.number().int().min(0),
  suppressedCount: z.number().int().min(0),
  skippedScopeMismatch: z.number().int().min(0),
  frozen: z.boolean(),
});
export type ScoringRunView = z.infer<typeof ScoringRunView>;

export const CycleIdParam = z.object({ cycleId: Ulid });

export const DashboardQuery = z
  .object({
    cycleId: Ulid.optional(),
    /**
     * Which terminal, for an operator that runs more than one. Keyed by airport
     * rather than by participation because a participation is per cycle, and the
     * thing a reader follows across cycles is the terminal.
     */
    airportId: Ulid.optional(),
  })
  .strict();
export type DashboardQuery = z.infer<typeof DashboardQuery>;

export const RollupQuery = z
  .object({
    cycleId: Ulid.optional(),
    participationId: Ulid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type RollupQuery = z.infer<typeof RollupQuery>;

export const TrendQuery = z
  .object({
    airportId: Ulid.optional(),
    limit: z.coerce.number().int().min(2).max(40).default(12),
  })
  .strict();
export type TrendQuery = z.infer<typeof TrendQuery>;

export const GapQuery = z.object({ cycleId: Ulid.optional(), airportId: Ulid.optional() }).strict();
export type GapQuery = z.infer<typeof GapQuery>;

/** How many league table rows a dashboard shows before the footnote takes over. */
export const RANKING_ROWS_SHOWN = 5;
