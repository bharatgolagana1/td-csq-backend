// The national view (ARCHITECTURE §6 `GET /reports/national`): airports
// ranked (the scoring module's national table), operators ranked by name, the
// category averages across operators and the participation funnel of the
// cycle (REQUIREMENTS §24) — all of it for the one survey type asked for.
import type { RequestContext } from '../../core/auth/session.js';

import { averageOf, cycleSummaryOf, indexRows, percentage, round2, rowAt } from './reports.figures.js';
import type { NationalReportDto, NationalReportQuery, ReportDirection, SurveyType } from './reports.schemas.js';
import { selectNationalCycle } from './reports.selection.js';
import {
  loadAirports,
  loadNationalTable,
  loadInvitationFunnel,
  loadOperators,
  loadParticipants,
  loadScores,
  loadSurveyTree,
  OVERALL_REF_ID,
  type CycleView,
  type InvitationFunnelView,
  type ParticipantView,
  type ScoreRowView,
  type SurveyTreeView,
} from './reports.sources.js';

const EMPTY_TREE: SurveyTreeView = { id: '', categories: [] };

function byRank<T extends { rank: number | null }>(name: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || name(a).localeCompare(name(b));
}

/** Every airport in the national table or with a participant running the survey type; the latter without figures until scored. */
async function airportsRanked(
  cycle: CycleView,
  surveyType: SurveyType,
  direction: ReportDirection,
  participants: readonly ParticipantView[],
): Promise<NationalReportDto['airports']> {
  const participating = [...new Set(participants.map((participant) => participant.airportId))];
  const [ranked, airports] = await Promise.all([loadNationalTable(cycle.id, surveyType, direction), loadAirports(participating)]);
  const rankedById = new Map(ranked.map((row) => [row.airportId, row]));
  const rankOf = ranked[0]?.rankOf ?? 0;
  const airportIds = [...new Set([...ranked.map((row) => row.airportId), ...participating])];
  return airportIds
    .map((airportId) => {
      const row = rankedById.get(airportId);
      const airport = airports.get(airportId);
      return {
        id: airportId,
        iata: row?.iata ?? airport?.iata ?? '?',
        name: row?.name ?? airport?.name ?? 'Unknown airport',
        rating: round2(row?.mean ?? null),
        rank: row?.rank ?? null,
        rankOf: row?.rankOf ?? rankOf,
        coveredSharePct: round2(row?.coveredSharePct ?? 0) ?? 0,
        marketShareApplied: row?.marketShareApplied ?? false,
      };
    })
    .sort(byRank((row) => row.iata));
}

/**
 * The operators that run the survey type and their funnel for it. A BOTH
 * cycle's participants each count both types in `cycle_participants.stats`,
 * so the funnel comes from that type's invitations.
 */
function participationOf(typed: readonly ParticipantView[], funnel: InvitationFunnelView): NationalReportDto['participation'] {
  const { invited, readyToSend, started, completed } = funnel;
  return {
    airports: new Set(typed.map((participant) => participant.airportId)).size,
    operators: typed.length,
    sampleLocked: typed.filter((participant) => participant.sampling.status === 'LOCKED').length,
    invited,
    readyToSend,
    started,
    completed,
    pending: Math.max(0, invited - completed),
    completionRate: percentage(completed, invited),
  };
}

export async function nationalReport(ctx: RequestContext, query: NationalReportQuery): Promise<NationalReportDto> {
  const { cycle, surveyType, direction, provisional } = await selectNationalCycle(ctx, query);
  const participants = await loadParticipants(cycle.id);
  const typed = participants.filter((participant) => participant.surveyTypes.includes(surveyType));
  const surveyId = cycle.surveyVersions[surveyType];

  const [airports, operators, operatorAirports, scores, tree, funnel] = await Promise.all([
    airportsRanked(cycle, surveyType, direction, typed),
    loadOperators(typed.map((participant) => participant.acoId)),
    loadAirports(typed.map((participant) => participant.airportId)),
    Promise.all(typed.map((participant) => loadScores(cycle.id, participant.acoId, surveyType, direction))),
    surveyId ? loadSurveyTree(surveyId) : EMPTY_TREE,
    loadInvitationFunnel(cycle.id, surveyType),
  ]);
  const indexed: Map<string, ScoreRowView>[] = scores.map((set) => indexRows(set.rows));
  const rankOf = Math.max(0, ...indexed.map((rows) => rowAt(rows, 'OVERALL', OVERALL_REF_ID)?.rankOf ?? 0));

  const operatorRows = typed
    .map((participant, i) => {
      const operator = operators.get(participant.acoId);
      const airport = operatorAirports.get(participant.airportId) ?? null;
      const overall = rowAt(indexed[i] ?? new Map<string, ScoreRowView>(), 'OVERALL', OVERALL_REF_ID);
      return {
        acoId: participant.acoId,
        code: operator?.code ?? '?',
        name: operator?.name ?? 'Unknown operator',
        airport,
        rating: round2(overall?.customer.mean ?? null),
        n: overall?.customer.n ?? 0,
        rank: overall?.rank ?? null,
        rankOf: overall?.rankOf ?? rankOf,
        ...(overall?.suppressed ? { suppressed: overall.suppressed } : {}),
      };
    })
    .sort(byRank((row) => row.name));

  return {
    cycle: cycleSummaryOf(cycle),
    surveyType,
    direction,
    provisional,
    airports,
    operators: operatorRows,
    categories: [...tree.categories]
      .sort((a, b) => a.order - b.order)
      .map((category) => ({
        id: category.id,
        code: category.code,
        name: category.name,
        ...averageOf(indexed.map((rows) => rowAt(rows, 'CATEGORY', category.code)?.customer.mean ?? null)),
      })),
    participation: participationOf(typed, funnel),
  };
}
