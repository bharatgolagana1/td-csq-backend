/**
 * Question → subcategory → category → overall roll-up of submitted
 * assessments into `ScoreRow`s (ARCHITECTURE.md §7 "Scoring").
 *
 * Rules applied here:
 * - Question score = mean of the non-NA ratings of CUSTOMER assessments. The
 *   FF / CB figures are the same mean over the customers of that type; SELF
 *   assessments are averaged separately and never touch a customer figure.
 * - Each parent level is the (weighted) mean of its children's means, exact,
 *   with a child that has no score dropping out (`weightedMean`). Weights come
 *   from `weightsFor`.
 * - `n` at every level is the number of distinct assessments that contributed
 *   at least one non-NA rating to a question under that level; `naCount` is
 *   the number of NA customer answers under it.
 * - A level is suppressed when the customer `n` is below `minResponses`; its
 *   customer and FF / CB means are then published as `null`. The FF / CB
 *   split is additionally hidden on its own when that type's `n` is below the
 *   threshold, so a single respondent's rating is never exposed through the
 *   split. Suppression is a publication rule only: the parent is still built
 *   from the child's exact mean, and judged by its own `n`.
 * - Inactive questions are skipped. An answer that is neither NA nor rated is
 *   unanswered and ignored. Rounding (2 dp) happens once, in `toRow`.
 *
 * Rows come out in pre-order of the survey tree as given: OVERALL, then each
 * category followed by its subcategories (each followed by its questions) and
 * its direct questions.
 */

import { meanExcludingNa, round2, weightedMean } from './means.js';
import type {
  AssessmentKind,
  CustomerType,
  MeanWithN,
  Rating,
  ScoreLevel,
  ScoreRow,
  ScoringSettings,
  SubmittedAssessment,
  SurveyCategory,
  SurveyQuestion,
  SurveyStructure,
  SurveySubcategory,
  WeightingMode,
} from './types.js';
import { OVERALL_REF_ID } from './types.js';
import { weightsFor } from './weights.js';

// ------------------------------------------------------------- answer index

interface IndexedAnswer {
  assessmentId: string;
  kind: AssessmentKind;
  customerType: CustomerType | undefined;
  rating: Rating | null;
  na: boolean;
}

/** questionId → assessmentId → answer (a later duplicate replaces an earlier one). */
type AnswerIndex = ReadonlyMap<string, ReadonlyMap<string, IndexedAnswer>>;

function indexAnswers(assessments: readonly SubmittedAssessment[]): AnswerIndex {
  const index = new Map<string, Map<string, IndexedAnswer>>();
  for (const assessment of assessments) {
    for (const answer of assessment.answers) {
      let perQuestion = index.get(answer.questionId);
      if (!perQuestion) {
        perQuestion = new Map();
        index.set(answer.questionId, perQuestion);
      }
      perQuestion.set(assessment.id, {
        assessmentId: assessment.id,
        kind: assessment.kind,
        customerType: assessment.customerType,
        rating: answer.rating,
        na: answer.na,
      });
    }
  }
  return index;
}

// ------------------------------------------------------------- node figures

/** An exact mean plus the distinct assessments behind it. */
interface Contribution {
  mean: number | null;
  ids: ReadonlySet<string>;
}

interface NodeStats {
  customer: Contribution;
  FF: Contribution;
  CB: Contribution;
  self: Contribution;
  naCount: number;
}

interface ScoredNode {
  level: ScoreLevel;
  refId: string;
  stats: NodeStats;
  children: ScoredNode[];
}

interface WeightedNode {
  node: ScoredNode;
  weightPct?: number;
}

class RatingBucket {
  readonly ratings: Rating[] = [];
  readonly ids = new Set<string>();

  add(assessmentId: string, rating: Rating): void {
    this.ratings.push(rating);
    this.ids.add(assessmentId);
  }

  contribution(): Contribution {
    return { mean: meanExcludingNa(this.ratings), ids: this.ids };
  }
}

function questionStats(questionId: string, index: AnswerIndex): NodeStats {
  const customer = new RatingBucket();
  const ff = new RatingBucket();
  const cb = new RatingBucket();
  const self = new RatingBucket();
  let naCount = 0;

  for (const answer of index.get(questionId)?.values() ?? []) {
    if (answer.na) {
      if (answer.kind === 'CUSTOMER') naCount += 1;
      continue;
    }
    if (answer.rating === null) continue; // unanswered
    if (answer.kind === 'SELF') {
      self.add(answer.assessmentId, answer.rating);
      continue;
    }
    customer.add(answer.assessmentId, answer.rating);
    if (answer.customerType === 'FF') ff.add(answer.assessmentId, answer.rating);
    if (answer.customerType === 'CB') cb.add(answer.assessmentId, answer.rating);
  }

  return {
    customer: customer.contribution(),
    FF: ff.contribution(),
    CB: cb.contribution(),
    self: self.contribution(),
    naCount,
  };
}

function unionIds(sets: readonly ReadonlySet<string>[]): ReadonlySet<string> {
  const union = new Set<string>();
  for (const set of sets) for (const id of set) union.add(id);
  return union;
}

function combine(children: readonly WeightedNode[], mode: WeightingMode): NodeStats {
  const weights = weightsFor(mode, children);
  const figure = (pick: (stats: NodeStats) => Contribution): Contribution => ({
    mean: weightedMean(
      children.map((child, i) => ({ mean: pick(child.node.stats).mean, weight: weights[i] ?? 0 })),
    ),
    ids: unionIds(children.map((child) => pick(child.node.stats).ids)),
  });
  return {
    customer: figure((stats) => stats.customer),
    FF: figure((stats) => stats.FF),
    CB: figure((stats) => stats.CB),
    self: figure((stats) => stats.self),
    naCount: children.reduce((sum, child) => sum + child.node.stats.naCount, 0),
  };
}

// --------------------------------------------------------------- the tree

function weighted(node: ScoredNode, weightPct: number | undefined): WeightedNode {
  return weightPct === undefined ? { node } : { node, weightPct };
}

function activeQuestions(questions: readonly SurveyQuestion[]): SurveyQuestion[] {
  return questions.filter((question) => question.active);
}

function scoreQuestion(question: SurveyQuestion, index: AnswerIndex): ScoredNode {
  return { level: 'QUESTION', refId: question.id, stats: questionStats(question.id, index), children: [] };
}

function scoreSubcategory(
  subcategory: SurveySubcategory,
  index: AnswerIndex,
  mode: WeightingMode,
): ScoredNode {
  const children = activeQuestions(subcategory.questions).map((question) =>
    weighted(scoreQuestion(question, index), question.weightPct),
  );
  return {
    level: 'SUBCATEGORY',
    refId: subcategory.id,
    stats: combine(children, mode),
    children: children.map((child) => child.node),
  };
}

function scoreCategory(category: SurveyCategory, index: AnswerIndex, mode: WeightingMode): ScoredNode {
  const children: WeightedNode[] = [
    ...category.subcategories.map((subcategory) =>
      weighted(scoreSubcategory(subcategory, index, mode), undefined),
    ),
    ...activeQuestions(category.questions).map((question) =>
      weighted(scoreQuestion(question, index), question.weightPct),
    ),
  ];
  return {
    level: 'CATEGORY',
    refId: category.id,
    stats: combine(children, mode),
    children: children.map((child) => child.node),
  };
}

function scoreOverall(survey: SurveyStructure, index: AnswerIndex, mode: WeightingMode): ScoredNode {
  const children = survey.categories.map((category) =>
    weighted(scoreCategory(category, index, mode), category.weightPct),
  );
  return {
    level: 'OVERALL',
    refId: OVERALL_REF_ID,
    stats: combine(children, mode),
    children: children.map((child) => child.node),
  };
}

// ---------------------------------------------------------- output boundary

function publish(contribution: Contribution, hidden: boolean): MeanWithN {
  return { mean: hidden ? null : round2(contribution.mean), n: contribution.ids.size };
}

function toRow(node: ScoredNode, minResponses: number): ScoreRow {
  const { stats } = node;
  const suppressed = stats.customer.ids.size < minResponses;
  const row: ScoreRow = {
    level: node.level,
    refId: node.refId,
    customer: {
      ...publish(stats.customer, suppressed),
      naCount: stats.naCount,
      byType: {
        FF: publish(stats.FF, suppressed || stats.FF.ids.size < minResponses),
        CB: publish(stats.CB, suppressed || stats.CB.ids.size < minResponses),
      },
    },
    self: publish(stats.self, false),
  };
  if (suppressed) row.suppressed = 'INSUFFICIENT_RESPONSES';
  return row;
}

function flatten(node: ScoredNode, minResponses: number, out: ScoreRow[]): ScoreRow[] {
  out.push(toRow(node, minResponses));
  for (const child of node.children) flatten(child, minResponses, out);
  return out;
}

/**
 * Scores one operator's submitted assessments for one survey against the
 * survey structure the cycle pinned. Returns one row per level and ref,
 * OVERALL first, means rounded to 2 dp.
 */
export function scoreAssessments(
  survey: SurveyStructure,
  assessments: readonly SubmittedAssessment[],
  settings: ScoringSettings,
): ScoreRow[] {
  const index = indexAnswers(assessments);
  const tree = scoreOverall(survey, index, settings.weightingMode);
  return flatten(tree, settings.minResponses, []);
}
