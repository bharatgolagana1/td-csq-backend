// The national view (ARCHITECTURE §6 `GET /reports/national`): airports
// ranked (the scoring module's national table), operators ranked by name, the
// category averages across operators and the participation funnel of the
// cycle (REQUIREMENTS §24).
import type { RequestContext } from '../../core/auth/session.js';

import { averageOf, cycleSummaryOf, indexRows, percentage, round2, rowAt } from './reports.figures.js';
import type { NationalReportDto, NationalReportQuery, SurveyType } from './reports.schemas.js';
import { selectNationalCycle } from './reports.selection.js';
import {
  loadAirports,
  loadNationalTable,
  loadOperators,
  loadParticipants,
  loadScores,
  loadSurveyTree,
  OVERALL_REF_ID,
  type CycleView,
  type ParticipantView,
  type ScoreRowView,
  type SurveyTreeView,
} from './reports.sources.js';

const EMPTY_TREE: SurveyTreeView = { id: '', categories: [] };

function byRank<T extends { rank: number | null }>(name: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || name(a).localeCompare(name(b));
}

/** Every airport in the national table or with a participant; the latter without figures until scored. */
async function airportsRanked(cycle: CycleView, surveyType: SurveyType, participants: readonly ParticipantView[]): Promise<NationalReportDto['airports']> {
  const participating = [...new Set(participants.map((participant) => participant.airportId))];
  const [ranked, airports] = await Promise.all([loadNationalTable(cycle.id, surveyType), loadAirports(participating)]);
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

export async function nationalReport(ctx: RequestContext, query: NationalReportQuery): Promise<NationalReportDto> {
  const { cycle, surveyType, provisional } = await selectNationalCycle(ctx, query);
  const participants = await loadParticipants(cycle.id);
  const typed = participants.filter((participant) => participant.surveyTypes.includes(surveyType));
  const surveyId = cycle.surveyVersions[surveyType];

  const [airports, operators, operatorAirports, scores, tree] = await Promise.all([
    airportsRanked(cycle, surveyType, participants),
    loadOperators(typed.map((participant) => participant.acoId)),
    loadAirports(typed.map((participant) => participant.airportId)),
    Promise.all(typed.map((participant) => loadScores(cycle.id, participant.acoId, surveyType))),
    surveyId ? loadSurveyTree(surveyId) : EMPTY_TREE,
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

  const invited = participants.reduce((sum, participant) => sum + participant.stats.invited, 0);
  const started = participants.reduce((sum, participant) => sum + participant.stats.started, 0);
  const completed = participants.reduce((sum, participant) => sum + participant.stats.completed, 0);

  return {
    cycle: cycleSummaryOf(cycle),
    surveyType,
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
    participation: {
      airports: new Set(participants.map((participant) => participant.airportId)).size,
      operators: participants.length,
      sampleLocked: participants.filter((participant) => participant.sampling.status === 'LOCKED').length,
      invited,
      started,
      completed,
      pending: Math.max(0, invited - completed),
      completionRate: percentage(completed, invited),
    },
  };
}
