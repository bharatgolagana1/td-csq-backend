import {
  isScored,
  scoreOf,
  MIN_RESPONSES_TO_PUBLISH,
  MIN_COVERAGE_BP_TO_PUBLISH,
  type Direction,
  type FormScope,
  type ScoreEnvelope,
} from '@csq/contracts';
import { BP, type MarketShareStage, type QuestionSpec, type SubmittedAssessment, type WeightingProfile } from './types.js';

/**
 * The scoring pipeline, as pure functions over already-validated input.
 *
 * S0  drop everything that must not score: NA ratings, unscored questions,
 *     non-rating answer types, and every SELF assessment
 * S1  collapse a question's directional ratings into one question score
 * S2  weight questions within their category, redistributing the weight of
 *     anything unanswered so NA never silently depresses a category
 * S3  weight categories into a composite
 * S4  optional market-share stage for airport and national roll-ups
 *
 * Each stage is separable because H7 is still open: market share must be able to
 * be switched off, re-parameterised, or promoted without touching the rest.
 */

export interface QuestionScore {
  readonly questionCode: string;
  readonly categoryCode: string;
  readonly weightBp: number;
  /** Mean of the directions that carried a real rating, 1-5. */
  readonly value: number;
  /** Kept so dashboards can slice export against import. */
  readonly byDirection: Readonly<Partial<Record<Direction, number>>>;
}

/** S0 + S1. Returns only questions that produced a usable score. */
export function scoreQuestions(
  assessment: SubmittedAssessment,
  specs: ReadonlyMap<string, QuestionSpec>,
): QuestionScore[] {
  if (assessment.assessorKind === 'SELF') return [];

  const out: QuestionScore[] = [];
  for (const answer of assessment.answers) {
    const spec = specs.get(answer.questionCode);
    if (!spec || !spec.scored || spec.answerType !== 'RATING_5' || spec.weightBp <= 0) continue;

    const byDirection: Partial<Record<Direction, number>> = {};
    let sum = 0;
    let n = 0;
    for (const r of answer.ratings) {
      if (!spec.applicableDirections.includes(r.direction)) continue;
      if (!isScored(r.rating)) continue; // NA leaves the calculation entirely
      const s = scoreOf(r.rating);
      if (s === null) continue;
      byDirection[r.direction] = s;
      sum += s;
      n += 1;
    }
    if (n === 0) continue; // every direction was NA: the question does not score

    out.push({
      questionCode: spec.code,
      categoryCode: spec.categoryCode,
      weightBp: spec.weightBp,
      value: sum / n,
      byDirection,
    });
  }
  return out;
}

export interface CategoryRollup {
  readonly categoryCode: string;
  readonly value: number;
  /** Share of this category's own weight that was answered. */
  readonly coverageBp: number;
}

/**
 * S2. Weights are renormalised over the questions that actually scored, so a
 * category answered 8-of-10 is the weighted mean of those 8 rather than being
 * scaled down toward zero by the two that did not apply.
 */
export function rollupCategories(
  questionScores: readonly QuestionScore[],
  specs: ReadonlyMap<string, QuestionSpec>,
  scope: FormScope,
): CategoryRollup[] {
  const answeredByCat = new Map<string, { weighted: number; weight: number }>();
  for (const q of questionScores) {
    const acc = answeredByCat.get(q.categoryCode) ?? { weighted: 0, weight: 0 };
    acc.weighted += q.value * q.weightBp;
    acc.weight += q.weightBp;
    answeredByCat.set(q.categoryCode, acc);
  }

  const availableByCat = new Map<string, number>();
  for (const spec of specs.values()) {
    if (!spec.scored || spec.answerType !== 'RATING_5') continue;
    if (!spec.applicableDirections.length) continue;
    if (!scopeHasQuestion(spec, scope)) continue;
    availableByCat.set(spec.categoryCode, (availableByCat.get(spec.categoryCode) ?? 0) + spec.weightBp);
  }

  const out: CategoryRollup[] = [];
  for (const [categoryCode, acc] of answeredByCat) {
    if (acc.weight <= 0) continue;
    const available = availableByCat.get(categoryCode) ?? acc.weight;
    out.push({
      categoryCode,
      value: acc.weighted / acc.weight,
      coverageBp: Math.round((acc.weight / available) * BP),
    });
  }
  return out.sort((a, b) => a.categoryCode.localeCompare(b.categoryCode));
}

/** Phase 1 keeps every seeded question in both scopes unless the bank says otherwise. */
function scopeHasQuestion(_spec: QuestionSpec, _scope: FormScope): boolean {
  return true;
}

/**
 * S3. Category weights are also renormalised across the categories that produced
 * a score, for the same reason as S2.
 */
export function composite(
  categories: readonly CategoryRollup[],
  profile: WeightingProfile,
  scope: FormScope,
): { value: number | null; coverageBp: number } {
  const weights = profile.categoryWeightBp[scope] ?? {};
  let weighted = 0;
  let usedWeight = 0;
  let coverageWeighted = 0;

  for (const c of categories) {
    const w = weights[c.categoryCode] ?? 0;
    if (w <= 0) continue;
    weighted += c.value * w;
    usedWeight += w;
    coverageWeighted += c.coverageBp * w;
  }
  if (usedWeight <= 0) return { value: null, coverageBp: 0 };

  const totalDeclared = Object.values(weights).reduce((a, b) => a + b, 0) || BP;
  return {
    value: weighted / usedWeight,
    // coverage is against the whole instrument, not just the answered part
    coverageBp: Math.round(((coverageWeighted / usedWeight) * usedWeight) / totalDeclared),
  };
}

/** S4. Off by default until H7 is answered. */
export function applyMarketShare(
  perAco: ReadonlyArray<{ acoId: string; value: number }>,
  stage: MarketShareStage,
): { value: number | null; applied: boolean } {
  if (stage.mode === 'OFF' || perAco.length === 0) {
    if (perAco.length === 0) return { value: null, applied: false };
    const mean = perAco.reduce((a, b) => a + b.value, 0) / perAco.length;
    return { value: mean, applied: false };
  }
  let weighted = 0;
  let used = 0;
  for (const row of perAco) {
    const share = stage.sharesBp[row.acoId] ?? 0;
    if (share <= 0) continue;
    weighted += row.value * share;
    used += share;
  }
  if (used <= 0) return { value: null, applied: false };
  return { value: weighted / used, applied: true };
}

/** Display rounding. One decimal, matching the published band. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function envelope(args: {
  value: number | null;
  coverageBp: number;
  responseCount: number;
  profile: WeightingProfile;
  marketShareApplied: boolean;
  scored: boolean;
}): ScoreEnvelope {
  const { value, coverageBp, responseCount, profile, marketShareApplied, scored } = args;

  let suppression: ScoreEnvelope['suppression'] = 'NONE';
  if (!scored) suppression = 'NOT_YET_SCORED';
  else if (responseCount < MIN_RESPONSES_TO_PUBLISH) suppression = 'BELOW_MIN_RESPONSES';
  else if (coverageBp < MIN_COVERAGE_BP_TO_PUBLISH) suppression = 'BELOW_MIN_COVERAGE';

  return {
    value: suppression === 'NONE' && value !== null ? round1(value) : null,
    scoreCoverageBp: coverageBp,
    responseCount,
    suppression,
    weightingProfile: { profileId: profile.profileId, version: profile.version },
    marketShareApplied,
  };
}
