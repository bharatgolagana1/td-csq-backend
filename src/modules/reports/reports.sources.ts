// Everything reports reads from the lower features, in the shapes the report
// builders consume. This is the only file in the module that imports another
// feature's service (WAVE1-BRIEF §2: cycles, assessments, scoring, surveys,
// organisations, airports); the builders never see a lower DTO, so a change in
// one of those contracts is absorbed here.
import type { RequestContext } from '../../core/auth/session.js';
import { idString } from '../../core/ids.js';
import { findAirportById, findAirportsByIds, listAirports } from '../airports/airports.service.js';
import { listSubmitted } from '../assessments/assessments.service.js';
import { getCycle, listCycles } from '../cycles/cycles.service.js';
import { getParticipant, listParticipants } from '../cycles/participants.service.js';
import type { OrganisationDoc } from '../organisations/organisations.model.js';
import { findOrganisationById, findOrganisationsByIds } from '../organisations/organisations.service.js';
import { OVERALL_REF_ID, type DistributionBucket, type Rating } from '../scoring/engine/index.js';
import type { AirportScoreDto, NationalRowDto, ScoreSetDto } from '../scoring/scoring.schemas.js';
import { getAirportScores, getScores, nationalTable } from '../scoring/scoring.service.js';
import { getSurveyTree } from '../surveys/surveys.service.js';

import type { SurveyType } from './reports.schemas.js';

export { OVERALL_REF_ID };

// --- views -----------------------------------------------------------------

export type CycleType = SurveyType | 'BOTH';

/** A cycle as listed: enough to pick a default cycle and to label a report. */
export interface CycleRef {
  id: string;
  code: string;
  name: string;
  type: CycleType;
  status: string;
  assessment: { start: Date; end: Date } | null;
  scoredAt: Date | null;
  createdAt: Date;
}

/** A cycle as read in full: adds the survey versions it pinned at publish. */
export interface CycleView extends CycleRef {
  surveyVersions: Partial<Record<SurveyType, string>>;
}

export interface ParticipantView {
  cycleId: string;
  acoId: string;
  airportId: string;
  surveyTypes: SurveyType[];
  sampling: { status: string; selectedCount: number };
  stats: { invited: number; started: number; completed: number };
}

export type ScoreLevel = 'QUESTION' | 'SUBCATEGORY' | 'CATEGORY' | 'OVERALL';

export interface MeanWithNView {
  mean: number | null;
  n: number;
}

/**
 * One `scores` row (ARCHITECTURE §5). `refId` is the survey node's stable
 * CODE (or `OVERALL_REF_ID`), which is how the scoring module publishes rows
 * so that cycles on different survey versions still line up.
 */
export interface ScoreRowView {
  level: ScoreLevel;
  refId: string;
  customer: MeanWithNView & { naCount: number; byType: { FF: MeanWithNView; CB: MeanWithNView } };
  self: MeanWithNView;
  suppressed?: 'INSUFFICIENT_RESPONSES';
  rank?: number | null;
  rankOf?: number;
  previous?: { cycleId: string; mean: number | null };
  delta?: number;
}

/** One operator's rows for one survey type in a cycle, with the feedback distribution the same run produced. */
export interface ScoreSetView {
  rows: ScoreRowView[];
  /** Empty until the operator has been scored for this type. */
  distribution: DistributionBucket[];
}

/** One `airport_scores` document with string ids; `refId` is a code, as above. */
export interface AirportScoreView {
  surveyType: SurveyType;
  level: ScoreLevel;
  refId: string;
  mean: number | null;
  marketShareApplied: boolean;
  coveredSharePct: number;
  operators: { acoId: string; mean: number | null; sharePct: number | null; suppressed: boolean }[];
  rank: number | null;
  rankOf: number;
}

/** One line of the scoring module's national table: an airport's rating and rank, never an operator's figures. */
export interface NationalRowView {
  airportId: string;
  iata: string;
  name: string;
  mean: number | null;
  rank: number | null;
  rankOf: number;
  marketShareApplied: boolean;
  coveredSharePct: number;
}

export interface SurveyQuestionView {
  id: string;
  code: string;
  text: string;
  order: number;
  active: boolean;
}

export interface SurveySubcategoryView {
  id: string;
  code: string;
  name: string;
  order: number;
  questions: SurveyQuestionView[];
}

export interface SurveyCategoryView {
  id: string;
  code: string;
  name: string;
  order: number;
  subcategories: SurveySubcategoryView[];
  questions: SurveyQuestionView[];
}

export interface SurveyTreeView {
  id: string;
  categories: SurveyCategoryView[];
}

export interface SubmittedAssessmentView {
  id: string;
  kind: 'CUSTOMER' | 'SELF';
  surveyType: SurveyType;
  customerType?: 'FF' | 'CB';
  answers: { questionId: string; rating: Rating | null; na: boolean; comment: string | null }[];
}

/** How many SUBMITTED assessments an operator has for a survey type in a cycle. */
export interface AssessmentCountsView {
  total: number;
  customer: number;
  self: number;
}

export interface OperatorView {
  id: string;
  code: string;
  name: string;
  airportId: string | null;
  status: string;
}

export interface AirportView {
  id: string;
  iata: string;
  name: string;
}

// --- cycles ----------------------------------------------------------------

type CycleListRow = Awaited<ReturnType<typeof listCycles>>['data'][number];
type CycleDetail = Awaited<ReturnType<typeof getCycle>>;

function toCycleRef(dto: CycleListRow | CycleDetail): CycleRef {
  return {
    id: dto.id,
    code: dto.code,
    name: dto.name,
    type: dto.type,
    status: dto.status,
    assessment: { start: new Date(dto.assessment.start.utc), end: new Date(dto.assessment.end.utc) },
    scoredAt: dto.scoredAt ? new Date(dto.scoredAt) : null,
    createdAt: new Date(dto.createdAt),
  };
}

/** The cycle, scoped by the cycles module (an ACO sees the cycles it takes part in); `null` when not visible. */
export async function loadCycle(ctx: RequestContext, cycleId: string): Promise<CycleView | null> {
  let dto: CycleDetail;
  try {
    dto = await getCycle(ctx, cycleId);
  } catch (error) {
    if ((error as { code?: string }).code === 'NOT_FOUND') return null;
    throw error;
  }
  return {
    ...toCycleRef(dto),
    surveyVersions: {
      ...(dto.surveyVersions.DOMESTIC ? { DOMESTIC: idString(dto.surveyVersions.DOMESTIC) } : {}),
      ...(dto.surveyVersions.INTERNATIONAL ? { INTERNATIONAL: idString(dto.surveyVersions.INTERNATIONAL) } : {}),
    },
  };
}

export interface CycleFilter {
  acoId?: string;
  airportId?: string;
}

/** The cycles the caller may see that include the operator / airport, newest first. */
export async function loadCycleRefs(ctx: RequestContext, filter: CycleFilter): Promise<CycleRef[]> {
  const page = await listCycles(ctx, { page: 1, pageSize: 200, ...filter });
  return page.data.map(toCycleRef).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

type ParticipantDto = NonNullable<Awaited<ReturnType<typeof getParticipant>>>;

function toParticipantView(dto: ParticipantDto): ParticipantView {
  return {
    cycleId: dto.cycleId,
    acoId: dto.acoId,
    airportId: dto.airportId,
    surveyTypes: [...dto.surveyTypes],
    sampling: { status: dto.sampling.status, selectedCount: dto.sampling.selectedCount },
    stats: { invited: dto.stats.invited, started: dto.stats.started, completed: dto.stats.completed },
  };
}

export async function loadParticipant(cycleId: string, acoId: string): Promise<ParticipantView | null> {
  const dto = await getParticipant(cycleId, acoId);
  return dto ? toParticipantView(dto) : null;
}

export async function loadParticipants(cycleId: string): Promise<ParticipantView[]> {
  return (await listParticipants(cycleId)).map(toParticipantView);
}

// --- scoring ---------------------------------------------------------------

function toScoreRowView(row: ScoreSetDto['rows'][number]): ScoreRowView {
  return {
    level: row.level,
    refId: row.refId,
    customer: {
      mean: row.customer.mean,
      n: row.customer.n,
      naCount: row.customer.naCount,
      byType: {
        FF: { mean: row.customer.byType.FF.mean, n: row.customer.byType.FF.n },
        CB: { mean: row.customer.byType.CB.mean, n: row.customer.byType.CB.n },
      },
    },
    self: { mean: row.self.mean, n: row.self.n },
    ...(row.suppressed ? { suppressed: row.suppressed } : {}),
    ...(row.rank !== undefined ? { rank: row.rank } : {}),
    ...(row.rankOf !== undefined ? { rankOf: row.rankOf } : {}),
    ...(row.previous ? { previous: { cycleId: idString(row.previous.cycleId), mean: row.previous.mean } } : {}),
    ...(row.delta !== undefined ? { delta: row.delta } : {}),
  };
}

export async function loadScores(cycleId: string, acoId: string, surveyType: SurveyType): Promise<ScoreSetView> {
  const set: ScoreSetDto = await getScores(cycleId, acoId, surveyType);
  return {
    rows: set.rows.map(toScoreRowView),
    distribution: set.distribution.map((bucket) => ({ rating: bucket.rating as Rating | null, label: bucket.label, count: bucket.count, pct: bucket.pct })),
  };
}

export async function loadAirportScores(cycleId: string, airportId: string, surveyType: SurveyType): Promise<AirportScoreView[]> {
  const rows: AirportScoreDto[] = await getAirportScores(cycleId, airportId);
  return rows
    .filter((row) => row.surveyType === surveyType)
    .map((row) => ({
      surveyType: row.surveyType,
      level: row.level,
      refId: row.refId,
      mean: row.mean,
      marketShareApplied: row.marketShareApplied,
      coveredSharePct: row.coveredSharePct,
      operators: row.operators.map((operator) => ({
        acoId: idString(operator.acoId),
        mean: operator.mean,
        sharePct: operator.sharePct,
        suppressed: operator.suppressed,
      })),
      rank: row.rank,
      rankOf: row.rankOf,
    }));
}

export async function loadNationalTable(cycleId: string, surveyType: SurveyType): Promise<NationalRowView[]> {
  const rows: NationalRowDto[] = await nationalTable(cycleId, surveyType);
  return rows.map((row) => ({
    airportId: idString(row.airportId),
    iata: row.iata,
    name: row.name,
    mean: row.mean,
    rank: row.rank,
    rankOf: row.rankOf,
    marketShareApplied: row.marketShareApplied,
    coveredSharePct: row.coveredSharePct,
  }));
}

// --- surveys ---------------------------------------------------------------

type SurveyTreeDto = Awaited<ReturnType<typeof getSurveyTree>>;
type QuestionDto = SurveyTreeDto['categories'][number]['questions'][number];

function toQuestionView(question: QuestionDto): SurveyQuestionView {
  return { id: question.id, code: question.code, text: question.text, order: question.order, active: question.active };
}

export async function loadSurveyTree(surveyId: string): Promise<SurveyTreeView> {
  const tree = await getSurveyTree(surveyId);
  return {
    id: tree.survey.id,
    categories: tree.categories.map((category) => ({
      id: category.id,
      code: category.code,
      name: category.name,
      order: category.order,
      subcategories: category.subcategories.map((subcategory) => ({
        id: subcategory.id,
        code: subcategory.code,
        name: subcategory.name,
        order: subcategory.order,
        questions: subcategory.questions.map(toQuestionView),
      })),
      questions: category.questions.map(toQuestionView),
    })),
  };
}

// --- assessments -----------------------------------------------------------

const RATINGS: readonly number[] = [1, 2, 3, 4, 5];

function toRating(value: number | null): Rating | null {
  return value !== null && RATINGS.includes(value) ? (value as Rating) : null;
}

/** SUBMITTED CUSTOMER assessments of one operator for one survey type, with answers (ratings, NA, comments). */
export async function loadSubmittedCustomerAssessments(
  cycleId: string,
  acoId: string,
  surveyType: SurveyType,
): Promise<SubmittedAssessmentView[]> {
  const docs = await listSubmitted(cycleId, acoId, 'CUSTOMER');
  return docs
    .filter((doc) => doc.surveyType === surveyType)
    .map((doc) => ({
      id: doc.id,
      kind: doc.kind,
      surveyType: doc.surveyType,
      ...(doc.customerType ? { customerType: doc.customerType } : {}),
      answers: doc.answers.map((answer) => ({
        questionId: answer.questionId,
        rating: toRating(answer.rating),
        na: answer.na,
        comment: answer.comment,
      })),
    }));
}

/** Every SUBMITTED assessment of one operator for one survey type, counted by kind (live, not the scoring run's snapshot). */
export async function loadSubmittedAssessmentCounts(cycleId: string, acoId: string, surveyType: SurveyType): Promise<AssessmentCountsView> {
  const docs = (await listSubmitted(cycleId, acoId)).filter((doc) => doc.surveyType === surveyType);
  const self = docs.filter((doc) => doc.kind === 'SELF').length;
  return { total: docs.length, customer: docs.length - self, self };
}

// --- organisations and airports -------------------------------------------

/** Airports live on the platform (`active`), whichever of them took part in a cycle. */
export async function countActiveAirports(): Promise<number> {
  return (await listAirports({ page: 1, pageSize: 1, active: true })).meta.total;
}

function toOperatorView(doc: OrganisationDoc): OperatorView {
  return {
    id: idString(doc._id),
    code: doc.code,
    name: doc.name,
    airportId: doc.airportId ? idString(doc.airportId) : null,
    status: doc.status,
  };
}

export async function loadOperator(acoId: string): Promise<OperatorView | null> {
  const doc = await findOrganisationById(acoId);
  return doc?.type === 'ACO' ? toOperatorView(doc) : null;
}

export async function loadOperators(acoIds: Iterable<string>): Promise<Map<string, OperatorView>> {
  const docs = await findOrganisationsByIds(acoIds);
  return new Map([...docs.values()].filter((doc) => doc.type === 'ACO').map((doc) => [idString(doc._id), toOperatorView(doc)]));
}

export async function loadAirport(airportId: string): Promise<AirportView | null> {
  const doc = await findAirportById(airportId);
  return doc ? { id: idString(doc._id), iata: doc.iata, name: doc.name } : null;
}

export async function loadAirports(airportIds: Iterable<string>): Promise<Map<string, AirportView>> {
  const docs = await findAirportsByIds(airportIds);
  return new Map([...docs.values()].map((doc) => [idString(doc._id), { id: idString(doc._id), iata: doc.iata, name: doc.name }]));
}
