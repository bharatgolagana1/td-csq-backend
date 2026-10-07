// The airport roll-up (ARCHITECTURE §6 `GET /reports/airport/:airportId`):
// the market-share weighted score the scoring module stored, the operators
// behind it (platform and airport callers only) and the per-category figures.
import type { RequestContext } from '../../core/auth/session.js';

import { requireVisibleAirport, seesOperatorFigures } from './reports.access.js';
import { cycleSummaryOf, round2 } from './reports.figures.js';
import type { AirportOperatorRowDto, AirportReportDto, AirportReportQuery } from './reports.schemas.js';
import { selectAirportCycle } from './reports.selection.js';
import {
  loadAirportScores,
  loadOperators,
  loadSurveyTree,
  OVERALL_REF_ID,
  type AirportScoreView,
  type ParticipantView,
  type SurveyTreeView,
} from './reports.sources.js';

const EMPTY_TREE: SurveyTreeView = { id: '', categories: [] };

function byMeanDescending(a: AirportOperatorRowDto, b: AirportOperatorRowDto): number {
  return (b.mean ?? -Infinity) - (a.mean ?? -Infinity) || a.name.localeCompare(b.name);
}

/**
 * The operators table: the stored roll-up's entries when the airport has been
 * scored, else the cycle's participants at the airport with no figures yet.
 */
async function operatorsTable(overall: AirportScoreView | undefined, participants: readonly ParticipantView[]): Promise<AirportOperatorRowDto[]> {
  const entries = overall
    ? overall.operators
    : participants.map((participant) => ({ acoId: participant.acoId, mean: null, sharePct: null, suppressed: true }));
  const operators = await loadOperators(entries.map((entry) => entry.acoId));
  return entries
    .map((entry) => {
      const operator = operators.get(entry.acoId);
      return {
        acoId: entry.acoId,
        code: operator?.code ?? '?',
        name: operator?.name ?? 'Unknown operator',
        mean: round2(entry.mean),
        sharePct: round2(entry.sharePct),
        suppressed: entry.suppressed,
      };
    })
    .sort(byMeanDescending);
}

export async function airportReport(ctx: RequestContext, airportId: string, query: AirportReportQuery): Promise<AirportReportDto> {
  const airport = await requireVisibleAirport(ctx, airportId);
  const { cycle, participants, surveyType, provisional } = await selectAirportCycle(ctx, airportId, query);
  const surveyId = cycle.surveyVersions[surveyType];
  const [rows, tree] = await Promise.all([
    loadAirportScores(cycle.id, airportId, surveyType),
    surveyId ? loadSurveyTree(surveyId) : EMPTY_TREE,
  ]);
  const overall = rows.find((row) => row.level === 'OVERALL' && row.refId === OVERALL_REF_ID);
  const byCategory = new Map(rows.filter((row) => row.level === 'CATEGORY').map((row) => [row.refId, row]));
  const operators = seesOperatorFigures(ctx) ? await operatorsTable(overall, participants) : undefined;

  return {
    cycle: cycleSummaryOf(cycle),
    surveyType,
    provisional,
    airport,
    overall: {
      mean: round2(overall?.mean ?? null),
      coveredSharePct: round2(overall?.coveredSharePct ?? 0) ?? 0,
      marketShareApplied: overall?.marketShareApplied ?? false,
      rank: overall?.rank ?? null,
      rankOf: overall?.rankOf ?? 0,
    },
    ...(operators ? { operators } : {}),
    categories: [...tree.categories]
      .sort((a, b) => a.order - b.order)
      .map((category) => {
        const row = byCategory.get(category.code);
        return {
          id: category.id,
          code: category.code,
          name: category.name,
          mean: round2(row?.mean ?? null),
          coveredSharePct: round2(row?.coveredSharePct ?? 0) ?? 0,
          marketShareApplied: row?.marketShareApplied ?? false,
        };
      }),
  };
}
