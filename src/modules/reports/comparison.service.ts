// Side-by-side comparison of one operator across cycles (ARCHITECTURE §6
// `GET /reports/comparison`, REQUIREMENTS §23 "comparison between assessment
// cycles"). Survey nodes are matched on their code — a new survey version
// gives every node a new id while codes stay stable, which is also how the
// scoring module keys its rows.
import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';

import { requireVisibleOperator } from './reports.access.js';
import { cycleSummaryOf, indexRows, isScored, NO_SCORE, operatorSummaryOf, round2, rowAt } from './reports.figures.js';
import type { ComparisonDto, ComparisonQuery, ComparisonRowDto, SurveyType } from './reports.schemas.js';
import {
  loadAirport,
  loadCycle,
  loadParticipant,
  loadScores,
  loadSurveyTree,
  OVERALL_REF_ID,
  type CycleView,
  type ParticipantView,
  type ScoreLevel,
  type ScoreRowView,
  type SurveyTreeView,
} from './reports.sources.js';

const EMPTY_TREE: SurveyTreeView = { id: '', categories: [] };

interface ComparedCycle {
  cycle: CycleView;
  participant: ParticipantView;
  rows: Map<string, ScoreRowView>;
  tree: SurveyTreeView;
}

interface NodeRef {
  level: ScoreLevel;
  code: string;
  name: string;
  parentCode: string | null;
  /** Position in the survey the node was first seen in; later cycles append. */
  order: number;
}

/** Walks a cycle's survey tree, adding each node to the union keyed by `level:code`. */
function collectNodes(union: Map<string, NodeRef>, tree: SurveyTreeView): void {
  const add = (level: ScoreLevel, node: { code: string; name: string }, parentCode: string | null): void => {
    const key = `${level}:${node.code}`;
    if (union.has(key)) return;
    union.set(key, { level, code: node.code, name: node.name, parentCode, order: union.size });
  };
  for (const category of [...tree.categories].sort((a, b) => a.order - b.order)) {
    add('CATEGORY', category, null);
    for (const subcategory of [...category.subcategories].sort((a, b) => a.order - b.order)) {
      add('SUBCATEGORY', subcategory, category.code);
      for (const question of [...subcategory.questions].sort((a, b) => a.order - b.order)) {
        if (question.active) add('QUESTION', { code: question.code, name: question.text }, subcategory.code);
      }
    }
    for (const question of [...category.questions].sort((a, b) => a.order - b.order)) {
      if (question.active) add('QUESTION', { code: question.code, name: question.text }, category.code);
    }
  }
}

function valueOf(cycleId: string, row: ScoreRowView | undefined): ComparisonRowDto['values'][number] {
  return {
    cycleId,
    customer: row ? { mean: round2(row.customer.mean), n: row.customer.n } : NO_SCORE,
    self: { mean: round2(row?.self.mean ?? null) },
    ...(row?.suppressed ? { suppressed: row.suppressed } : {}),
  };
}

function rowsAtLevel(union: Map<string, NodeRef>, level: ScoreLevel, compared: readonly ComparedCycle[]): ComparisonRowDto[] {
  return [...union.values()]
    .filter((node) => node.level === level)
    .sort((a, b) => a.order - b.order)
    .map((node) => ({
      code: node.code,
      name: node.name,
      parentCode: node.parentCode,
      values: compared.map(({ cycle, rows }) => valueOf(cycle.id, rowAt(rows, level, node.code))),
    }));
}

async function loadCompared(ctx: RequestContext, acoId: string, cycleId: string, surveyType: SurveyType | undefined): Promise<ComparedCycle> {
  const cycle = await loadCycle(ctx, cycleId);
  const participant = cycle ? await loadParticipant(cycle.id, acoId) : null;
  if (!cycle || !participant) throw new AppError('NOT_FOUND', `Operator did not take part in cycle ${cycleId}`);
  const type = surveyType ?? participant.surveyTypes[0];
  const surveyId = type ? cycle.surveyVersions[type] : undefined;
  const [scores, tree] = await Promise.all([
    type && participant.surveyTypes.includes(type) ? loadScores(cycle.id, acoId, type) : { rows: [], distribution: [] },
    surveyId ? loadSurveyTree(surveyId) : EMPTY_TREE,
  ]);
  return { cycle, participant, rows: indexRows(scores.rows), tree };
}

export async function comparisonReport(ctx: RequestContext, query: ComparisonQuery): Promise<ComparisonDto> {
  const operator = await requireVisibleOperator(ctx, query.acoId);
  const first = await loadCompared(ctx, operator.id, query.cycleIds[0] ?? '', query.surveyType);
  const surveyType = query.surveyType ?? first.participant.surveyTypes[0];
  if (!surveyType) throw new AppError('NOT_FOUND', 'Operator has nothing to assess in this cycle');
  const rest = await Promise.all(query.cycleIds.slice(1).map((cycleId) => loadCompared(ctx, operator.id, cycleId, surveyType)));
  const compared = [first, ...rest];

  const union = new Map<string, NodeRef>();
  for (const { tree } of compared) collectNodes(union, tree);

  return {
    operator: operatorSummaryOf(operator, operator.airportId ? await loadAirport(operator.airportId) : null),
    surveyType,
    cycles: compared.map(({ cycle }) => ({ ...cycleSummaryOf(cycle), provisional: !isScored(cycle) })),
    overall: compared.map(({ cycle, rows }) => {
      const overall = rowAt(rows, 'OVERALL', OVERALL_REF_ID);
      return { ...valueOf(cycle.id, overall), rank: overall?.rank ?? null, rankOf: overall?.rankOf ?? 0 };
    }),
    categories: rowsAtLevel(union, 'CATEGORY', compared),
    subcategories: rowsAtLevel(union, 'SUBCATEGORY', compared),
    questions: rowsAtLevel(union, 'QUESTION', compared),
  };
}
