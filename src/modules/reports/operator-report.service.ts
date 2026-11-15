// The operator dashboard (ARCHITECTURE §6 `GET /reports/operator/:acoId`) and
// its question-level table. Composes the scoring module's rows (keyed by the
// survey node's code) with the survey tree the cycle pinned and the
// participant's assessment funnel; never another operator's figures, and no
// airport ranking (that is the national report's). Every figure is in the
// selection's direction (SINGLE, IMPORT or EXPORT).
import type { RequestContext } from '../../core/auth/session.js';
import { feedbackDistribution } from '../scoring/engine/index.js';

import { requireVisibleOperator } from './reports.access.js';
import {
  byTypeOf,
  cycleSummaryOf,
  indexRows,
  levelFiguresOf,
  NO_SCORE,
  operatorSummaryOf,
  round2,
  rowAt,
} from './reports.figures.js';
import type {
  AssessorStatsDto,
  CategoryReportDto,
  OperatorQuestionsDto,
  OperatorReportDto,
  OperatorReportQuery,
  QuestionReportRowDto,
} from './reports.schemas.js';
import { selectOperatorCycle, type OperatorSelection } from './reports.selection.js';
import {
  loadAirport,
  loadCycle,
  loadReadyToSend,
  loadScores,
  loadSubmittedAssessmentCounts,
  loadSubmittedCustomerAssessments,
  loadSurveyTree,
  OVERALL_REF_ID,
  type OperatorView,
  type ParticipantView,
  type ScoreRowView,
  type ScoreSetView,
  type SubmittedAssessmentView,
  type SurveyCategoryView,
  type SurveyQuestionView,
  type SurveyTreeView,
} from './reports.sources.js';

const EMPTY_TREE: SurveyTreeView = { id: '', categories: [] };

interface OperatorReportInputs {
  operator: OperatorView;
  selection: OperatorSelection;
  scores: ScoreSetView;
  rows: Map<string, ScoreRowView>;
  tree: SurveyTreeView;
}

/** What both operator views share: visibility, cycle selection, the score rows and the survey tree. */
async function loadOperatorInputs(ctx: RequestContext, acoId: string, query: OperatorReportQuery): Promise<OperatorReportInputs> {
  const operator = await requireVisibleOperator(ctx, acoId);
  const selection = await selectOperatorCycle(ctx, acoId, query);
  const surveyId = selection.cycle.surveyVersions[selection.surveyType];
  const [scores, tree] = await Promise.all([
    loadScores(selection.cycle.id, acoId, selection.surveyType, selection.direction),
    surveyId ? loadSurveyTree(surveyId) : EMPTY_TREE,
  ]);
  return { operator, selection, scores, rows: indexRows(scores.rows), tree };
}

function byOrder<T extends { order: number }>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => a.order - b.order);
}

function categoriesOf(tree: SurveyTreeView, rows: Map<string, ScoreRowView>): CategoryReportDto[] {
  return byOrder(tree.categories).map((category) => ({
    id: category.id,
    code: category.code,
    name: category.name,
    ...levelFiguresOf(rowAt(rows, 'CATEGORY', category.code)),
    subcategories: byOrder(category.subcategories).map((subcategory) => ({
      id: subcategory.id,
      code: subcategory.code,
      name: subcategory.name,
      ...levelFiguresOf(rowAt(rows, 'SUBCATEGORY', subcategory.code)),
    })),
  }));
}

/**
 * `started` counts every assessment opened, finished ones included. A completed
 * assessment was necessarily begun, so `begun` never trails `completed` even
 * when the opener was not counted; the funnel never goes negative. `total`
 * counts the invitations e-mailed; `readyToSend` those prepared at lock that
 * wait for the assessment window.
 */
function assessorStatsOf(participant: ParticipantView, readyToSend: number): AssessorStatsDto {
  const { invited, started, completed } = participant.stats;
  const begun = Math.max(started, completed);
  return {
    total: invited,
    completed,
    inProgress: begun - completed,
    yetToStart: Math.max(0, invited - begun),
    readyToSend,
  };
}

/** The distribution the scoring run stored; the six empty buckets before the operator has been scored. */
function distributionOf(scores: ScoreSetView): OperatorReportDto['feedbackDistribution'] {
  return scores.distribution.length > 0 ? scores.distribution : feedbackDistribution([]);
}

async function comparisonOf(
  ctx: RequestContext,
  inputs: OperatorReportInputs,
  overall: ScoreRowView | undefined,
): Promise<OperatorReportDto['comparison']> {
  const { cycle, surveyType, direction } = inputs.selection;
  const current = { cycleId: cycle.id, cycleName: cycle.name, customer: round2(overall?.customer.mean ?? null), self: round2(overall?.self.mean ?? null) };
  if (!overall?.previous) return { current, previous: null };
  const [previousCycle, previousScores] = await Promise.all([
    loadCycle(ctx, overall.previous.cycleId),
    loadScores(overall.previous.cycleId, inputs.operator.id, surveyType, direction),
  ]);
  const previousOverall = rowAt(indexRows(previousScores.rows), 'OVERALL', OVERALL_REF_ID);
  return {
    current,
    previous: {
      cycleId: overall.previous.cycleId,
      cycleName: previousCycle?.name ?? overall.previous.cycleId,
      customer: round2(overall.previous.mean),
      self: round2(previousOverall?.self.mean ?? null),
    },
  };
}

export async function operatorReport(ctx: RequestContext, acoId: string, query: OperatorReportQuery): Promise<OperatorReportDto> {
  const inputs = await loadOperatorInputs(ctx, acoId, query);
  const { operator, selection, scores, rows, tree } = inputs;
  const { cycle, participant, surveyType, direction, provisional } = selection;
  const overall = rowAt(rows, 'OVERALL', OVERALL_REF_ID);

  const [airport, comparison, assessments, readyToSend] = await Promise.all([
    operator.airportId ? loadAirport(operator.airportId) : null,
    comparisonOf(ctx, inputs, overall),
    loadSubmittedAssessmentCounts(cycle.id, operator.id, surveyType),
    loadReadyToSend(cycle.id, operator.id),
  ]);

  return {
    cycle: cycleSummaryOf(cycle),
    surveyType,
    direction,
    provisional,
    operator: operatorSummaryOf(operator, airport),
    overall: {
      customer: overall ? { mean: round2(overall.customer.mean), n: overall.customer.n } : NO_SCORE,
      self: { mean: round2(overall?.self.mean ?? null) },
      rank: overall?.rank ?? null,
      rankOf: overall?.rankOf ?? 0,
      ...(overall?.suppressed ? { suppressed: overall.suppressed } : {}),
    },
    comparison,
    feedbackDistribution: distributionOf(scores),
    categories: categoriesOf(tree, rows),
    byStakeholder: byTypeOf(overall),
    assessorStats: assessorStatsOf(participant, readyToSend),
    assessments,
  };
}

// --- question level --------------------------------------------------------

/** Customer answers carrying a comment, per question id. */
function commentCounts(assessments: readonly SubmittedAssessmentView[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const assessment of assessments) {
    for (const answer of assessment.answers) {
      if (!answer.comment?.trim()) continue;
      counts.set(answer.questionId, (counts.get(answer.questionId) ?? 0) + 1);
    }
  }
  return counts;
}

function questionRow(
  question: SurveyQuestionView,
  category: SurveyCategoryView,
  subcategory: { code: string; name: string } | null,
  rows: Map<string, ScoreRowView>,
  comments: Map<string, number>,
): QuestionReportRowDto {
  const row = rowAt(rows, 'QUESTION', question.code);
  const figures = levelFiguresOf(row);
  return {
    id: question.id,
    code: question.code,
    text: question.text,
    category: { code: category.code, name: category.name },
    subcategory,
    ...figures,
    customer: { ...figures.customer, naCount: row?.customer.naCount ?? 0 },
    comments: comments.get(question.id) ?? 0,
  };
}

/** Active questions in survey order: each category's subcategories (with their questions) then its direct questions. */
function questionRows(tree: SurveyTreeView, rows: Map<string, ScoreRowView>, comments: Map<string, number>): QuestionReportRowDto[] {
  const out: QuestionReportRowDto[] = [];
  for (const category of byOrder(tree.categories)) {
    for (const subcategory of byOrder(category.subcategories)) {
      for (const question of byOrder(subcategory.questions)) {
        if (question.active) out.push(questionRow(question, category, { code: subcategory.code, name: subcategory.name }, rows, comments));
      }
    }
    for (const question of byOrder(category.questions)) {
      if (question.active) out.push(questionRow(question, category, null, rows, comments));
    }
  }
  return out;
}

export async function operatorQuestions(ctx: RequestContext, acoId: string, query: OperatorReportQuery): Promise<OperatorQuestionsDto> {
  const { operator, selection, rows, tree } = await loadOperatorInputs(ctx, acoId, query);
  const { cycle, surveyType, direction, provisional } = selection;
  const [airport, assessments] = await Promise.all([
    operator.airportId ? loadAirport(operator.airportId) : null,
    loadSubmittedCustomerAssessments(cycle.id, operator.id, surveyType, direction),
  ]);
  return {
    cycle: cycleSummaryOf(cycle),
    surveyType,
    direction,
    provisional,
    operator: operatorSummaryOf(operator, airport),
    questions: questionRows(tree, rows, commentCounts(assessments)),
  };
}
