/**
 * Input and output shapes of the scoring engine.
 *
 * The engine is pure: it receives already-loaded documents (a survey tree,
 * submitted assessments, the scoring settings) and returns plain values that
 * mirror the `scores` and `airport_scores` documents of ARCHITECTURE.md §5
 * minus the identifying fields (`cycleId`, `acoId`, `surveyType`) that the
 * scoring service adds when it persists them.
 */

/** Rating scale: Poor = 1, Fair = 2, Good = 3, Very Good = 4, Excellent = 5. */
export type Rating = 1 | 2 | 3 | 4 | 5;

export type CustomerType = 'FF' | 'CB';

export type AssessmentKind = 'CUSTOMER' | 'SELF';

export type WeightingMode = 'EQUAL' | 'WEIGHTED';

export type ScoreLevel = 'QUESTION' | 'SUBCATEGORY' | 'CATEGORY' | 'OVERALL';

export type SuppressionReason = 'INSUFFICIENT_RESPONSES';

/** `refId` of the OVERALL row; the other levels use the survey node id. */
export const OVERALL_REF_ID = 'OVERALL';

// ---------------------------------------------------------------- inputs

export interface SurveyQuestion {
  id: string;
  code: string;
  text: string;
  /** Relative weight among its siblings in WEIGHTED mode; see weights.ts. */
  weightPct?: number;
  mandatory: boolean;
  /** Inactive questions are not scored and do not appear in the output. */
  active: boolean;
}

export interface SurveySubcategory {
  id: string;
  code: string;
  name: string;
  order: number;
  questions: readonly SurveyQuestion[];
}

export interface SurveyCategory {
  id: string;
  code: string;
  name: string;
  /** Relative weight among categories in WEIGHTED mode; see weights.ts. */
  weightPct?: number;
  order: number;
  subcategories: readonly SurveySubcategory[];
  /** Questions attached directly to the category (no subcategory). */
  questions: readonly SurveyQuestion[];
}

export interface SurveyStructure {
  categories: readonly SurveyCategory[];
}

export interface AssessmentAnswer {
  questionId: string;
  /** `null` when NA or unanswered. */
  rating: Rating | null;
  na: boolean;
}

/** A SUBMITTED assessment; the service filters on status before calling. */
export interface SubmittedAssessment {
  id: string;
  kind: AssessmentKind;
  /** Set on CUSTOMER assessments; drives the FF / CB split. */
  customerType?: CustomerType;
  answers: readonly AssessmentAnswer[];
}

export interface ScoringSettings {
  /** A level whose customer `n` is below this is suppressed. */
  minResponses: number;
  weightingMode: WeightingMode;
}

// --------------------------------------------------------------- outputs

/**
 * A mean and the number of distinct assessments that contributed a non-NA
 * rating to it. `mean` is `null` when nothing contributed or when the figure
 * is suppressed.
 */
export interface MeanWithN {
  mean: number | null;
  n: number;
}

export interface CustomerFigures extends MeanWithN {
  /** Number of NA answers given by customers across the level's questions. */
  naCount: number;
  byType: {
    FF: MeanWithN;
    CB: MeanWithN;
  };
}

/** One `scores` document without `cycleId`, `acoId`, `surveyType`. */
export interface ScoreRow {
  level: ScoreLevel;
  /** Question / subcategory / category id, or `OVERALL_REF_ID`. */
  refId: string;
  customer: CustomerFigures;
  self: MeanWithN;
  suppressed?: SuppressionReason;
}

export interface DistributionBucket {
  /** 5..1, or `null` for NA. */
  rating: Rating | null;
  label: 'Excellent' | 'Very Good' | 'Good' | 'Fair' | 'Poor' | 'NA';
  count: number;
  /** Percentage of all customer answers, 2 dp; the buckets sum to 100. */
  pct: number;
}

export interface RankEntry {
  acoId: string;
  /** Published (2 dp) overall customer mean; `null` when suppressed. */
  mean: number | null;
}

export interface RankedEntry extends RankEntry {
  /** Dense rank, 1 = best; `null` when `mean` is `null`. */
  rank: number | null;
  /** Number of entries with a non-null mean. */
  rankOf: number;
}

export interface AirportOperatorInput {
  acoId: string;
  /** Published operator mean at this level; `null` when suppressed. */
  mean: number | null;
  /** Market share snapshot for the cycle; missing or 0 means "no share". */
  sharePct?: number | null;
}

export interface AirportOperatorFigure {
  acoId: string;
  mean: number | null;
  sharePct: number | null;
  suppressed: boolean;
}

/** One `airport_scores` document without the identifying fields and ranks. */
export interface AirportScore {
  mean: number | null;
  marketShareApplied: boolean;
  /** Share (or, without market share, operator count) that carries a score, in %. */
  coveredSharePct: number;
  operators: AirportOperatorFigure[];
}

export interface AirportRollupOptions {
  /** Below this covered share the airport mean is `null`. Default 50. */
  minCoveredSharePct?: number;
}

export interface PreviousCycleScores {
  cycleId: string;
  rows: readonly ScoreRow[];
}

export interface PreviousFigure {
  cycleId: string;
  mean: number | null;
}

export interface WithPrevious {
  previous?: PreviousFigure;
  /** `current.customer.mean - previous.mean`, 2 dp; only when both are known. */
  delta?: number;
}
