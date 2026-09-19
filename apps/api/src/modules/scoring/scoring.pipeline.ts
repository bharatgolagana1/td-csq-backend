import {
  BP,
  applyMarketShare,
  composite,
  envelope,
  round1,
  rollupCategories,
  scoreQuestions,
  type MarketShareStage,
  type QuestionSpec,
  type SubmittedAssessment,
  type WeightingProfile,
} from '@csq/core';
import {
  RATING_SCALE,
  isScored,
  type Direction,
  type FormScope,
  type RatingKey,
  type ScoreEnvelope,
} from '@csq/contracts';
import type { AssessmentInput, InstrumentInput, WeightingProfileInput } from './scoring.inputs.js';

/**
 * Composition over the pure stages in @csq/core. Nothing here reimplements the
 * arithmetic: S0 and S1 are scoreQuestions, S2 is rollupCategories, S3 is
 * composite, S4 is applyMarketShare and the publication gate is envelope. This
 * file decides only which answers enter which stage, and how several returns
 * for one operator become one figure.
 *
 * It is free of IO so the two things a bug is unrecoverable in, what gets
 * published and what gets suppressed, can be tested without a database.
 */

/** Bumped when the composition below changes, so a stored rollup says how it was made. */
export const PIPELINE_VERSION = 'csq-scoring/S0-S4/1';

/**
 * The instrument says what is asked; the profile says what it is worth. Where
 * the published profile names a question, its weight is the one that counts,
 * and the instrument's own figure is the fallback for a question the profile
 * has not reached yet.
 */
export function specsOf(
  instrument: InstrumentInput,
  questionWeightBp: Readonly<Record<string, number>> = {},
): Map<string, QuestionSpec> {
  const out = new Map<string, QuestionSpec>();
  for (const question of instrument.questions) {
    out.set(question.code, {
      code: question.code,
      categoryCode: question.categoryCode,
      answerType: question.answerType,
      weightBp: questionWeightBp[question.code] ?? question.weightBp,
      scored: question.scored,
      applicableDirections: question.applicableDirections,
    });
  }
  return out;
}

/** Questions that can carry a score, per category. What "23 parameters" counts. */
export function parameterCounts(specs: ReadonlyMap<string, QuestionSpec>): Map<string, number> {
  const out = new Map<string, number>();
  for (const spec of specs.values()) {
    if (!spec.scored || spec.answerType !== 'RATING_5' || spec.weightBp <= 0) continue;
    out.set(spec.categoryCode, (out.get(spec.categoryCode) ?? 0) + 1);
  }
  return out;
}

export function toWeightingProfile(profile: WeightingProfileInput): WeightingProfile {
  return {
    profileId: profile._id,
    version: profile.version,
    categoryWeightBp: {
      INTERNATIONAL: profile.weights.INTERNATIONAL.categories,
      DOMESTIC: profile.weights.DOMESTIC.categories,
    },
    weightingBasis: profile.basis,
  };
}

export function questionWeightsFor(
  profile: WeightingProfileInput,
  scope: FormScope,
): Readonly<Record<string, number>> {
  return profile.weights[scope].questions;
}

/**
 * A profile whose category weights do not sum to the full 10000 would publish a
 * composite built from a fraction of the instrument while reporting it as whole.
 * Checked before a run rather than at the point a figure is already stored.
 */
export function weightingProblems(profile: WeightingProfile, scope: FormScope): string[] {
  const weights = profile.categoryWeightBp[scope];
  const codes = Object.keys(weights);
  if (codes.length === 0) return [`the profile declares no category weights for ${scope}`];

  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total !== BP) {
    return [`${scope} category weights sum to ${total} basis points, not ${BP}`];
  }
  return [];
}

function toSubmitted(assessment: AssessmentInput): SubmittedAssessment {
  return {
    assessmentId: assessment._id,
    assessorKind: assessment.assessorKind,
    formScope: assessment.formScope,
    answers: assessment.answers.map((answer) => ({
      questionCode: answer.questionCode,
      ratings: answer.ratings.map((r) => ({ direction: r.direction, rating: r.rating })),
    })),
  };
}

/** One direction's slice of a return, so export can be scored against import. */
function restrictToDirection(assessment: SubmittedAssessment, direction: Direction): SubmittedAssessment {
  return {
    ...assessment,
    answers: assessment.answers
      .map((answer) => ({
        questionCode: answer.questionCode,
        ratings: answer.ratings.filter((r) => r.direction === direction),
      }))
      .filter((answer) => answer.ratings.length > 0),
  };
}

export interface TrackCategory {
  readonly categoryCode: string;
  readonly value: number;
  readonly coverageBp: number;
  /** Assessors who answered enough of this category for it to score. */
  readonly responseCount: number;
}

export interface TrackResult {
  readonly value: number | null;
  readonly coverageBp: number;
  readonly responseCount: number;
  readonly categories: readonly TrackCategory[];
}

const EMPTY_TRACK: TrackResult = { value: null, coverageBp: 0, responseCount: 0, categories: [] };

/**
 * Several returns for one operator become one figure by giving each assessor an
 * equal voice: every return is scored on its own through S0 to S2, and the
 * category means across returns are what S3 weights.
 *
 * Pooling every answer before weighting would let the assessor who answered all
 * 23 parameters outvote the one who answered six, which is not what a survey of
 * customers measures.
 */
export function runTrack(args: {
  assessments: readonly SubmittedAssessment[];
  specs: ReadonlyMap<string, QuestionSpec>;
  profile: WeightingProfile;
  scope: FormScope;
  direction?: Direction;
}): TrackResult {
  const { assessments, specs, profile, scope, direction } = args;

  const perAssessment = assessments
    .map((assessment) => {
      const scoped = direction === undefined ? assessment : restrictToDirection(assessment, direction);
      return rollupCategories(scoreQuestions(scoped, specs), specs, scope);
    })
    .filter((categories) => categories.length > 0);

  if (perAssessment.length === 0) return EMPTY_TRACK;

  const accumulated = new Map<string, { value: number; coverage: number; count: number }>();
  for (const categories of perAssessment) {
    for (const category of categories) {
      const acc = accumulated.get(category.categoryCode) ?? { value: 0, coverage: 0, count: 0 };
      acc.value += category.value;
      acc.coverage += category.coverageBp;
      acc.count += 1;
      accumulated.set(category.categoryCode, acc);
    }
  }

  const categories: TrackCategory[] = [...accumulated]
    .map(([categoryCode, acc]) => ({
      categoryCode,
      value: acc.value / acc.count,
      coverageBp: Math.round(acc.coverage / acc.count),
      responseCount: acc.count,
    }))
    .sort((a, b) => a.categoryCode.localeCompare(b.categoryCode));

  const rolled = composite(categories, profile, scope);
  return {
    value: rolled.value,
    coverageBp: rolled.coverageBp,
    responseCount: perAssessment.length,
    categories,
  };
}

/**
 * The customer track: everything that may reach a published score. scoreQuestions
 * drops SELF at S0, so a self assessment passed through here contributes nothing
 * even if one were handed to it by mistake.
 */
export function customerTrack(
  assessments: readonly AssessmentInput[],
  specs: ReadonlyMap<string, QuestionSpec>,
  profile: WeightingProfile,
  scope: FormScope,
  direction?: Direction,
): TrackResult {
  return runTrack({
    assessments: assessments.filter((a) => a.assessorKind !== 'SELF').map(toSubmitted),
    specs,
    profile,
    scope,
    direction,
  });
}

/**
 * The self track, reported back to the operator and never published.
 *
 * The scorer refuses a SELF assessment outright, which is the correct default
 * and the reason self can never flatter a rating. The perception gap still needs
 * the same arithmetic applied to the same answers, so the self return is
 * presented to the scorer on its own track, in its own call, with a result type
 * that no published structure accepts: SelfTrackResult is never widened to a
 * ScoreEnvelope, never enters runTrack's customer input, and never reaches the
 * cohort snapshot. The relabel below exists only to get past a guard whose whole
 * purpose is served by keeping these two calls apart, and it is the only place
 * in the codebase that does it.
 */
export interface SelfTrackResult {
  readonly value: number | null;
  readonly coverageBp: number;
  readonly responseCount: number;
  readonly categories: ReadonlyArray<{ categoryCode: string; value: number }>;
}

export function selfTrack(
  assessments: readonly AssessmentInput[],
  specs: ReadonlyMap<string, QuestionSpec>,
  profile: WeightingProfile,
  scope: FormScope,
): SelfTrackResult {
  const own = assessments
    .filter((assessment) => assessment.assessorKind === 'SELF')
    .map((assessment) => ({ ...toSubmitted(assessment), assessorKind: 'EXTERNAL' as const }));

  const track = runTrack({ assessments: own, specs, profile, scope });
  return {
    value: track.value,
    coverageBp: track.coverageBp,
    responseCount: track.responseCount,
    categories: track.categories.map((c) => ({ categoryCode: c.categoryCode, value: c.value })),
  };
}

/** Self minus customer. Positive means the operator rates itself above its customers. */
export function gapOf(self: number | null, customer: number | null): number | null {
  if (self === null || customer === null) return null;
  return round1(self - customer);
}

export interface PublishedTrack {
  readonly overall: ScoreEnvelope;
  readonly categories: ReadonlyArray<ScoreEnvelope & { categoryCode: string }>;
}

/**
 * The publication gate. `scored` false means the cycle has not been frozen yet,
 * which is a different answer from "too few responses" and is stored as such
 * rather than as a bare null.
 */
export function publishTrack(
  track: TrackResult,
  profile: WeightingProfile,
  args: { scored: boolean; marketShareApplied: boolean },
): PublishedTrack {
  const overall = envelope({
    value: track.value,
    coverageBp: track.coverageBp,
    responseCount: track.responseCount,
    profile,
    marketShareApplied: args.marketShareApplied,
    scored: args.scored,
  });

  const categories = track.categories.map((category) => ({
    categoryCode: category.categoryCode,
    ...envelope({
      value: category.value,
      coverageBp: category.coverageBp,
      // a category answered by two of seven assessors is an anecdote about that
      // category even when the composite behind it is publishable
      responseCount: category.responseCount,
      profile,
      marketShareApplied: args.marketShareApplied,
      scored: args.scored,
    }),
  }));

  return { overall, categories };
}

export interface RatingTally {
  readonly key: RatingKey;
  readonly label: string;
  readonly count: number;
  readonly percent: number;
}

const TALLIED_KEYS: readonly RatingKey[] = RATING_SCALE.filter((r) => r.score !== null).map((r) => r.key);
const LABELS: ReadonlyMap<RatingKey, string> = new Map(RATING_SCALE.map((r) => [r.key, r.label]));

/**
 * What the feedback panel counts: individual directional ratings, not returns.
 * NA is excluded because it is not a sixth band, and self assessments are
 * excluded because the panel describes what customers said.
 */
export function tallyRatings(
  assessments: readonly AssessmentInput[],
  specs: ReadonlyMap<string, QuestionSpec>,
): RatingTally[] {
  const counts = new Map<RatingKey, number>(TALLIED_KEYS.map((key) => [key, 0]));

  for (const assessment of assessments) {
    if (assessment.assessorKind === 'SELF') continue;
    for (const answer of assessment.answers) {
      const spec = specs.get(answer.questionCode);
      if (!spec || !spec.scored || spec.answerType !== 'RATING_5' || spec.weightBp <= 0) continue;
      for (const rating of answer.ratings) {
        if (!spec.applicableDirections.includes(rating.direction)) continue;
        if (!isScored(rating.rating)) continue;
        counts.set(rating.rating, (counts.get(rating.rating) ?? 0) + 1);
      }
    }
  }

  return withPercentages([...counts].map(([key, count]) => ({ key, count })));
}

/**
 * Whole percentages that still sum to 100. Rounding each share on its own is how
 * a five band chart ends up reading 99% or 101%.
 */
export function withPercentages(rows: ReadonlyArray<{ key: RatingKey; count: number }>): RatingTally[] {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const ordered = TALLIED_KEYS.map((key) => ({
    key,
    count: rows.find((row) => row.key === key)?.count ?? 0,
  }));

  if (total === 0) {
    return ordered.map((row) => ({ ...row, label: LABELS.get(row.key) ?? row.key, percent: 0 }));
  }

  const exact = ordered.map((row) => ({ ...row, share: (row.count * 100) / total }));
  const floors = exact.map((row) => ({ ...row, percent: Math.floor(row.share) }));
  let remaining = 100 - floors.reduce((sum, row) => sum + row.percent, 0);

  const byRemainder = [...floors].sort((a, b) => b.share - Math.floor(b.share) - (a.share - Math.floor(a.share)));
  for (const row of byRemainder) {
    if (remaining <= 0) break;
    row.percent += 1;
    remaining -= 1;
  }

  return floors.map((row) => ({
    key: row.key,
    label: LABELS.get(row.key) ?? row.key,
    count: row.count,
    percent: row.percent,
  }));
}

export interface AirportCandidate {
  readonly airportId: string | null;
  readonly airportIata: string;
  readonly airportName: string;
  readonly airportFullName: string;
  readonly terminalName: string;
  readonly terminalCount: number;
  readonly orgIds: readonly string[];
  readonly responseCount: number;
  /** Composites of the publishable operators at this airport. */
  readonly operators: ReadonlyArray<{ acoId: string; value: number }>;
  /**
   * The stage for this airport alone. Market share is published per airport or
   * not at all, so it cannot be one setting for the whole cohort.
   */
  readonly marketShare: MarketShareStage;
}

export interface RankedAirport extends AirportCandidate {
  readonly rating: number | null;
  readonly rank: number | null;
  readonly marketShareApplied: boolean;
}

/**
 * S4 and the league table. An airport with two assessed terminals is one row,
 * combined by the market share stage, which is off until that question is
 * settled and then means the mean of its operators.
 *
 * Ties share a rank and the next rank skips, which is how a published league
 * table behaves. An airport with nothing publishable is listed without a rank
 * rather than dropped, so the cohort size is not quietly redefined by
 * suppression.
 */
export function rankAirports(candidates: readonly AirportCandidate[]): RankedAirport[] {
  const combined = candidates.map((candidate) => {
    const applied = applyMarketShare(candidate.operators, candidate.marketShare);
    return {
      ...candidate,
      rating: applied.value === null ? null : round1(applied.value),
      marketShareApplied: applied.applied,
      rank: null as number | null,
    };
  });

  const ranked = combined
    .filter((row) => row.rating !== null)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.airportIata.localeCompare(b.airportIata));

  let lastRating: number | null = null;
  let lastRank = 0;
  ranked.forEach((row, index) => {
    if (lastRating !== null && row.rating === lastRating) {
      row.rank = lastRank;
      return;
    }
    row.rank = index + 1;
    lastRank = index + 1;
    lastRating = row.rating;
  });

  return combined.sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return a.airportIata.localeCompare(b.airportIata);
  });
}

export interface CohortStatistics {
  readonly count: number;
  readonly mean: number;
  readonly median: number;
  readonly p25: number;
  readonly p75: number;
  readonly min: number;
  readonly max: number;
}

/** Linear interpolation between the two neighbouring ratings, the usual quartile. */
function percentile(sorted: readonly number[], fraction: number): number {
  const last = sorted.length - 1;
  const position = fraction * last;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) throw new Error('percentile over an empty cohort');
  if (lower === upper) return low;
  return low + (high - low) * (position - lower);
}

/** Null rather than a fabricated zero when nothing in the cohort is publishable. */
export function cohortStatistics(ratings: readonly number[]): CohortStatistics | null {
  if (ratings.length === 0) return null;
  const sorted = [...ratings].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return null;

  return {
    count: sorted.length,
    mean: round1(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    median: round1(percentile(sorted, 0.5)),
    p25: round1(percentile(sorted, 0.25)),
    p75: round1(percentile(sorted, 0.75)),
    min: round1(first),
    max: round1(last),
  };
}
