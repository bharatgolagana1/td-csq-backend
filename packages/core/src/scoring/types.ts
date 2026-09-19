import type { Direction, FormScope, RatingKey } from '@csq/contracts';

/** A single submitted return, already validated, as the scorer sees it. */
export interface SubmittedAssessment {
  readonly assessmentId: string;
  readonly assessorKind: 'SELF' | 'CUSTOMER' | 'EXTERNAL';
  readonly formScope: FormScope;
  readonly answers: ReadonlyArray<{
    readonly questionCode: string;
    readonly ratings: ReadonlyArray<{ readonly direction: Direction; readonly rating: RatingKey }>;
  }>;
}

/** The scoring-relevant slice of a published question bank snapshot. */
export interface QuestionSpec {
  readonly code: string;
  readonly categoryCode: string;
  /** Only RATING_5 questions may carry weight. */
  readonly answerType: 'RATING_5' | 'TEXT' | 'SINGLE_SELECT';
  readonly weightBp: number;
  readonly scored: boolean;
  readonly applicableDirections: readonly Direction[];
}

export interface WeightingProfile {
  readonly profileId: string;
  readonly version: number;
  /** Per scope, per category, summing to 10000 over categories present in that scope. */
  readonly categoryWeightBp: Readonly<Record<FormScope, Readonly<Record<string, number>>>>;
  readonly weightingBasis: 'EQUAL' | 'CONFIGURED';
}

export interface MarketShareStage {
  readonly mode: 'OFF' | 'AIRPORT_ROLLUP';
  /** acoId -> basis points, summing to 10000 across subscribed operators. */
  readonly sharesBp: Readonly<Record<string, number>>;
}

export const BP = 10_000;
