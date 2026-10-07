// Scoring runs and the read functions reports compose over (ARCHITECTURE §6
// "scoring and reports", §7 "Scoring"). The arithmetic is the engine's; this
// file loads the documents, publishes rows by code, ranks operators, rolls
// airports up with the cycle's market-share snapshot, persists atomically per
// operator / airport and survey type, and announces `scoring.completed`.
import type { AnyBulkWriteOperation, Types } from 'mongoose';

import { assertScope, assertTask } from '../../core/auth/rbac.js';
import type { RequestContext } from '../../core/auth/session.js';
import { isSystemContext, requestContextOf, systemContext, type AnyContext } from '../../core/auth/system.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { emit, type CycleStatus, type SurveyType } from '../../core/events.js';
import { idString, toId } from '../../core/ids.js';
import { audit } from '../audit/audit.service.js';
import type { CycleDoc } from '../cycles/cycles.model.js';
import { requireVisibleCycle } from '../cycles/cycles.service.js';

import { AirportScoreModel, type AirportScoreDoc } from './airport-scores.model.js';
import {
  feedbackDistribution,
  OVERALL_REF_ID,
  rankOperators,
  rollupAirport,
  rowKey,
  scoreAssessments,
  withPrevious,
  type AirportScore,
  type DistributionBucket,
  type PreviousCycleScores,
  type ScoreLevel,
  type ScoreRow,
  type ScoringSettings,
  type WithPrevious,
} from './engine/index.js';
import { ScoreModel, SURVEY_TYPES, type ResponseCounts, type ScoreDoc } from './scores.model.js';
import type { AirportScoreDto, NationalRowDto, RunInput, RunSummaryDto, ScoreRowDto, ScoreSetDto } from './scoring.schemas.js';
import {
  findPreviousScoredCycle,
  loadAirports,
  loadCycle,
  loadParticipants,
  loadScoringSettings,
  loadShareSnapshot,
  loadSubmitted,
  loadSurvey,
  pinnedSurveyId,
  type LoadedSurvey,
  type ParticipantRef,
} from './scoring.sources.js';

/** A cycle can be scored once its assessment has opened; a SCORED cycle may be re-run (idempotent). */
export const SCORABLE_STATUSES: readonly CycleStatus[] = ['ASSESSMENT_OPEN', 'ASSESSMENT_CLOSED', 'SCORED'];

export interface RunOptions {
  /** True while the assessment is still open: dashboards show live figures, the cycle is not marked SCORED. */
  provisional: boolean;
  /** Who triggered the run, for the audit row; the system when absent. */
  ctx?: AnyContext;
  now?: Date;
}

type ScoredRow = ScoreRow & WithPrevious;

interface OperatorResult {
  participant: ParticipantRef;
  rows: ScoredRow[];
  distribution: DistributionBucket[];
  counts: ResponseCounts;
  rank: number | null;
  rankOf: number;
}

interface AirportResult {
  airportId: string;
  level: ScoreLevel;
  refId: string;
  order: number;
  figure: AirportScore;
  rank: number | null;
  rankOf: number;
}

const ZERO_COUNTS: ResponseCounts = { customer: 0, self: 0, FF: 0, CB: 0 };

// --- the run -----------------------------------------------------------------

function overallMean(rows: readonly ScoreRow[]): number | null {
  return rows.find((row) => row.level === 'OVERALL' && row.refId === OVERALL_REF_ID)?.customer.mean ?? null;
}

function toEngineRow(doc: ScoreDoc): ScoreRow {
  const row: ScoreRow = {
    level: doc.level,
    refId: doc.refId,
    customer: {
      mean: doc.customer.mean,
      n: doc.customer.n,
      naCount: doc.customer.naCount,
      byType: {
        FF: { mean: doc.customer.byType.FF.mean, n: doc.customer.byType.FF.n },
        CB: { mean: doc.customer.byType.CB.mean, n: doc.customer.byType.CB.n },
      },
    },
    self: { mean: doc.self.mean, n: doc.self.n },
  };
  if (doc.suppressed) row.suppressed = doc.suppressed;
  return row;
}

/** The operator's rows in the previous cycle (already keyed by code), or null when it did not take part. */
async function loadPreviousRows(previousCycleId: Types.ObjectId, acoId: string, surveyType: SurveyType): Promise<PreviousCycleScores | null> {
  const docs = await ScoreModel.find({ cycleId: previousCycleId, acoId: toId(acoId, 'acoId'), surveyType }).lean<ScoreDoc[]>();
  if (docs.length === 0) return null;
  return { cycleId: idString(previousCycleId), rows: docs.map(toEngineRow) };
}

/**
 * One operator, one survey type: the engine's roll-up over its SUBMITTED
 * assessments, rows re-keyed from node ids to stable codes, then the previous
 * cycle's figures attached. The engine matches answers on question ids; the
 * code mapping happens after it so a re-versioned survey still compares.
 */
async function scoreOperator(
  cycleId: string,
  surveyType: SurveyType,
  survey: LoadedSurvey,
  settings: ScoringSettings,
  previous: CycleDoc | null,
  participant: ParticipantRef,
): Promise<Omit<OperatorResult, 'rank' | 'rankOf'>> {
  const { assessments, counts } = await loadSubmitted(cycleId, participant.acoId, surveyType);
  const byCode = scoreAssessments(survey.structure, assessments, settings).map((row) => ({
    ...row,
    refId: survey.codeOf.get(row.refId) ?? row.refId,
  }));
  const previousRows = previous ? await loadPreviousRows(previous._id, participant.acoId, surveyType) : null;
  return {
    participant,
    rows: withPrevious(byCode, previousRows),
    distribution: feedbackDistribution(assessments, survey.activeQuestionIds),
    counts,
  };
}

/** Upserts the operator's rows and drops any ref the survey no longer has, in one transaction. */
async function persistOperator(
  cycle: CycleDoc,
  surveyType: SurveyType,
  surveyId: string,
  result: OperatorResult,
  provisional: boolean,
  computedAt: Date,
): Promise<void> {
  const cycleId = cycle._id;
  const acoId = toId(result.participant.acoId, 'acoId');
  const airportId = toId(result.participant.airportId, 'airportId');
  const operations: AnyBulkWriteOperation<ScoreDoc>[] = result.rows.map((row, order) => {
    const overall = row.level === 'OVERALL';
    return {
      updateOne: {
        filter: { cycleId, acoId, surveyType, level: row.level, refId: row.refId },
        update: {
          $set: {
            airportId,
            surveyId,
            order,
            customer: row.customer,
            self: row.self,
            suppressed: row.suppressed ?? null,
            rank: overall ? result.rank : null,
            rankOf: overall ? result.rankOf : null,
            previous: row.previous ? { cycleId: toId(row.previous.cycleId, 'cycleId'), mean: row.previous.mean } : null,
            delta: row.delta ?? null,
            distribution: overall ? result.distribution : null,
            counts: overall ? result.counts : null,
            provisional,
            computedAt,
          },
        },
        upsert: true,
      },
    };
  });
  await withTransaction(async (session) => {
    await ScoreModel.bulkWrite(operations, { session });
    await ScoreModel.deleteMany(
      { cycleId, acoId, surveyType, $nor: result.rows.map((row) => ({ level: row.level, refId: row.refId })) },
      { session },
    );
  });
}

/**
 * Airport roll-up per level and ref over the operators at the airport that run
 * this survey type, weighted by the cycle's market-share snapshot (equal
 * weights when the airport has none), then airports ranked per level and ref.
 */
function rollupAirports(results: readonly OperatorResult[], snapshots: ReadonlyMap<string, ReadonlyMap<string, number> | null>): AirportResult[] {
  const byAirport = new Map<string, OperatorResult[]>();
  for (const result of results) {
    const group = byAirport.get(result.participant.airportId);
    if (group) group.push(result);
    else byAirport.set(result.participant.airportId, [result]);
  }

  const out: AirportResult[] = [];
  for (const [airportId, operators] of byAirport) {
    const snapshot = snapshots.get(airportId) ?? null;
    const refs = new Map<string, { level: ScoreLevel; refId: string; order: number }>();
    const rowsByOperator = operators.map((operator) => {
      const byKey = new Map<string, ScoredRow>();
      operator.rows.forEach((row, order) => {
        const key = rowKey(row);
        byKey.set(key, row);
        if (!refs.has(key)) refs.set(key, { level: row.level, refId: row.refId, order });
      });
      return byKey;
    });
    for (const [key, ref] of refs) {
      const inputs = operators.map((operator, i) => ({
        acoId: operator.participant.acoId,
        mean: rowsByOperator[i]?.get(key)?.customer.mean ?? null,
        sharePct: snapshot?.get(operator.participant.acoId) ?? null,
      }));
      out.push({ airportId, ...ref, figure: rollupAirport(inputs), rank: null, rankOf: 0 });
    }
  }

  const byRef = new Map<string, AirportResult[]>();
  for (const result of out) {
    const key = `${result.level}:${result.refId}`;
    const group = byRef.get(key);
    if (group) group.push(result);
    else byRef.set(key, [result]);
  }
  for (const group of byRef.values()) {
    const ranked = rankOperators(group.map((result) => ({ acoId: result.airportId, mean: result.figure.mean })));
    ranked.forEach((entry, i) => {
      const target = group[i];
      if (target) {
        target.rank = entry.rank;
        target.rankOf = entry.rankOf;
      }
    });
  }
  return out;
}

async function persistAirport(
  cycle: CycleDoc,
  surveyType: SurveyType,
  airportId: string,
  results: readonly AirportResult[],
  provisional: boolean,
  computedAt: Date,
): Promise<void> {
  const cycleId = cycle._id;
  const airportOid = toId(airportId, 'airportId');
  const operations: AnyBulkWriteOperation<AirportScoreDoc>[] = results.map((result) => ({
    updateOne: {
      filter: { cycleId, airportId: airportOid, surveyType, level: result.level, refId: result.refId },
      update: {
        $set: {
          order: result.order,
          mean: result.figure.mean,
          marketShareApplied: result.figure.marketShareApplied,
          coveredSharePct: result.figure.coveredSharePct,
          operators: result.figure.operators.map((operator) => ({
            acoId: toId(operator.acoId, 'acoId'),
            mean: operator.mean,
            sharePct: operator.sharePct,
            suppressed: operator.suppressed,
          })),
          rank: result.rank,
          rankOf: result.rankOf,
          provisional,
          computedAt,
        },
      },
      upsert: true,
    },
  }));
  await withTransaction(async (session) => {
    await AirportScoreModel.bulkWrite(operations, { session });
    await AirportScoreModel.deleteMany(
      { cycleId, airportId: airportOid, surveyType, $nor: results.map((result) => ({ level: result.level, refId: result.refId })) },
      { session },
    );
  });
}

/**
 * Contract: recomputes every score of the cycle. Per survey type the cycle
 * pinned: each participant running it is scored against the pinned survey
 * tree with the current `settings.scoring`, compared with the most recent
 * SCORED cycle, ranked on the OVERALL customer mean; then every airport is
 * rolled up with the cycle's market-share snapshot and ranked. Rows are
 * written per operator / airport in a transaction and keyed by code, so a
 * re-run replaces figures in place. Audited as `scoring.run`; emits
 * `scoring.completed` (cycles marks the cycle SCORED when not provisional).
 */
export async function runCycle(cycleId: string, options: RunOptions): Promise<RunSummaryDto> {
  const cycle = await loadCycle(cycleId);
  if (!SCORABLE_STATUSES.includes(cycle.status)) {
    throw new AppError('PRECONDITION_FAILED', `Cycle ${cycle.code} cannot be scored while ${cycle.status}; scoring starts once the assessment opens`, {
      cycleId,
      status: cycle.status,
    });
  }
  const ctx = options.ctx ?? systemContext(`scoring: cycle ${cycle.code}`);
  const computedAt = options.now ?? new Date();
  const { provisional } = options;
  const [settings, participants] = await Promise.all([loadScoringSettings(), loadParticipants(cycleId)]);
  const surveyTypes: SurveyType[] = SURVEY_TYPES.filter((type) => pinnedSurveyId(cycle, type) !== null);
  const operatorsScored = new Set<string>();
  const airportsScored = new Set<string>();
  let rows = 0;
  let airportRows = 0;

  for (const surveyType of surveyTypes) {
    const surveyId = pinnedSurveyId(cycle, surveyType);
    if (surveyId === null) continue;
    const [survey, previous] = await Promise.all([loadSurvey(surveyId), findPreviousScoredCycle(cycle, surveyType)]);
    const members = participants.filter((participant) => participant.surveyTypes.includes(surveyType));

    const scored: Omit<OperatorResult, 'rank' | 'rankOf'>[] = [];
    for (const member of members) scored.push(await scoreOperator(cycleId, surveyType, survey, settings, previous, member));
    const ranked = rankOperators(scored.map((result) => ({ acoId: result.participant.acoId, mean: overallMean(result.rows) })));
    const results: OperatorResult[] = scored.map((result, i) => ({ ...result, rank: ranked[i]?.rank ?? null, rankOf: ranked[i]?.rankOf ?? 0 }));
    for (const result of results) {
      await persistOperator(cycle, surveyType, surveyId, result, provisional, computedAt);
      operatorsScored.add(result.participant.acoId);
      rows += result.rows.length;
    }
    await ScoreModel.deleteMany({ cycleId: cycle._id, surveyType, acoId: { $nin: members.map((member) => toId(member.acoId, 'acoId')) } });

    const airportIds = [...new Set(members.map((member) => member.airportId))];
    const snapshots = new Map(await Promise.all(airportIds.map(async (airportId) => [airportId, await loadShareSnapshot(cycleId, airportId)] as const)));
    const airportResults = rollupAirports(results, snapshots);
    for (const airportId of airportIds) {
      const own = airportResults.filter((result) => result.airportId === airportId);
      if (own.length === 0) continue;
      await persistAirport(cycle, surveyType, airportId, own, provisional, computedAt);
      airportsScored.add(airportId);
      airportRows += own.length;
    }
    await AirportScoreModel.deleteMany({ cycleId: cycle._id, surveyType, airportId: { $nin: airportIds.map((id) => toId(id, 'airportId')) } });
  }
  await Promise.all([
    ScoreModel.deleteMany({ cycleId: cycle._id, surveyType: { $nin: surveyTypes } }),
    AirportScoreModel.deleteMany({ cycleId: cycle._id, surveyType: { $nin: surveyTypes } }),
  ]);

  const summary: RunSummaryDto = {
    cycleId,
    provisional,
    computedAt: computedAt.toISOString(),
    surveyTypes,
    operators: operatorsScored.size,
    airports: airportsScored.size,
    rows,
    airportRows,
  };
  await audit(requestContextOf(ctx), {
    action: 'scoring.run',
    entity: 'cycle',
    entityId: cycleId,
    after: { ...summary, code: cycle.code, status: cycle.status, trigger: isSystemContext(ctx) ? ctx.reason : 'request', settings },
    orgId: null,
  });
  await emit('scoring.completed', { cycleId, provisional }, { ctx });
  return summary;
}

/**
 * `POST /scoring/cycles/:cycleId/run`: `cycles.operate` on a PLATFORM
 * organisation (403 otherwise), the cycle in scope (404 otherwise). A run
 * while the assessment is open is provisional; afterwards it is final unless
 * the body asks for provisional.
 */
export async function runCycleForRequest(ctx: RequestContext, cycleId: string, input: RunInput): Promise<RunSummaryDto> {
  assertTask(ctx, 'cycles.operate');
  assertScope(ctx, 'PLATFORM');
  const cycle = await requireVisibleCycle(ctx, cycleId);
  const provisional = cycle.status === 'ASSESSMENT_OPEN' || input?.provisional === true;
  return runCycle(cycleId, { provisional, ctx });
}

// --- reads (contract) --------------------------------------------------------

function toRowDto(doc: ScoreDoc): ScoreRowDto {
  const row: ScoreRowDto = {
    level: doc.level,
    refId: doc.refId,
    customer: {
      mean: doc.customer.mean,
      n: doc.customer.n,
      naCount: doc.customer.naCount,
      byType: {
        FF: { mean: doc.customer.byType.FF.mean, n: doc.customer.byType.FF.n },
        CB: { mean: doc.customer.byType.CB.mean, n: doc.customer.byType.CB.n },
      },
    },
    self: { mean: doc.self.mean, n: doc.self.n },
  };
  if (doc.suppressed) row.suppressed = doc.suppressed;
  if (doc.level === 'OVERALL') {
    row.rank = doc.rank;
    row.rankOf = doc.rankOf ?? 0;
  }
  if (doc.previous) row.previous = { cycleId: idString(doc.previous.cycleId), mean: doc.previous.mean };
  if (doc.delta !== null) row.delta = doc.delta;
  return row;
}

/**
 * Contract: one operator's rows for a survey type in tree order (OVERALL
 * first), with the feedback distribution and the response counts of the run.
 * Empty rows, zero counts and `computedAt: null` when nothing has been scored.
 */
export async function getScores(cycleId: string, acoId: string, surveyType: SurveyType): Promise<ScoreSetDto> {
  const docs = await ScoreModel.find({ cycleId: toId(cycleId, 'cycleId'), acoId: toId(acoId, 'acoId'), surveyType })
    .sort({ order: 1 })
    .lean<ScoreDoc[]>();
  const overall = docs.find((doc) => doc.level === 'OVERALL');
  return {
    cycleId,
    acoId,
    surveyType,
    surveyId: overall?.surveyId ?? null,
    provisional: overall?.provisional ?? null,
    computedAt: overall?.computedAt.toISOString() ?? null,
    rows: docs.map(toRowDto),
    distribution: overall?.distribution ?? feedbackDistribution([]),
    counts: overall?.counts ?? { ...ZERO_COUNTS },
  };
}

function toAirportDto(doc: AirportScoreDoc): AirportScoreDto {
  return {
    cycleId: idString(doc.cycleId),
    airportId: idString(doc.airportId),
    surveyType: doc.surveyType,
    level: doc.level,
    refId: doc.refId,
    mean: doc.mean,
    marketShareApplied: doc.marketShareApplied,
    coveredSharePct: doc.coveredSharePct,
    operators: doc.operators.map((operator) => ({
      acoId: idString(operator.acoId),
      mean: operator.mean,
      sharePct: operator.sharePct,
      suppressed: operator.suppressed,
    })),
    rank: doc.rank,
    rankOf: doc.rankOf,
    provisional: doc.provisional,
    computedAt: doc.computedAt.toISOString(),
  };
}

/** Contract: every airport row of the cycle (both survey types), in survey type then tree order. */
export async function getAirportScores(cycleId: string, airportId: string): Promise<AirportScoreDto[]> {
  const docs = await AirportScoreModel.find({ cycleId: toId(cycleId, 'cycleId'), airportId: toId(airportId, 'airportId') })
    .sort({ surveyType: 1, order: 1 })
    .lean<AirportScoreDoc[]>();
  return docs.map(toAirportDto);
}

/**
 * Contract: the airports of the cycle ranked on their OVERALL figure for a
 * survey type, best first (unscored last, by IATA). Carries airport ratings
 * and ranks only — never an operator's figures — so an ACO may see it as-is.
 */
export async function nationalTable(cycleId: string, surveyType: SurveyType): Promise<NationalRowDto[]> {
  const docs = await AirportScoreModel.find({ cycleId: toId(cycleId, 'cycleId'), surveyType, level: 'OVERALL', refId: OVERALL_REF_ID }).lean<
    AirportScoreDoc[]
  >();
  const airports = await loadAirports(docs.map((doc) => doc.airportId));
  return docs
    .map((doc): NationalRowDto => {
      const airportId = idString(doc.airportId);
      const airport = airports.get(airportId);
      return {
        airportId,
        iata: airport?.iata ?? '?',
        name: airport?.name ?? 'Unknown airport',
        mean: doc.mean,
        rank: doc.rank,
        rankOf: doc.rankOf,
        marketShareApplied: doc.marketShareApplied,
        coveredSharePct: doc.coveredSharePct,
        provisional: doc.provisional,
        computedAt: doc.computedAt.toISOString(),
      };
    })
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.iata.localeCompare(b.iata));
}
