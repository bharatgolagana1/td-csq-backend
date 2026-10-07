// Everything scoring reads from the features below it (cycles, surveys,
// assessments, settings, organisations, airports), in the shapes the engine
// consumes. This is the only file in the module that imports another
// feature's service, so a change in a neighbour's contract is absorbed here.
import type { Types } from 'mongoose';

import { AppError } from '../../core/errors.js';
import type { SurveyType } from '../../core/events.js';
import { idString, toId } from '../../core/ids.js';
import { findAirportsByIds } from '../airports/airports.service.js';
import { listSubmitted } from '../assessments/assessments.service.js';
import type { CycleDoc } from '../cycles/cycles.model.js';
import { findCycleDoc, findCyclesByStatus } from '../cycles/cycles.service.js';
import { listParticipants } from '../cycles/participants.service.js';
import { MarketShareModel, type MarketShareDoc } from '../organisations/market-shares.model.js';
import { getSettingsDoc } from '../settings/settings.service.js';
import { getSurveyTree } from '../surveys/surveys.service.js';

import type { Rating, ScoringSettings, SubmittedAssessment, SurveyQuestion, SurveyStructure } from './engine/index.js';
import type { ResponseCounts } from './scores.model.js';

// --- cycles ----------------------------------------------------------------

export async function loadCycle(cycleId: string): Promise<CycleDoc> {
  const cycle = await findCycleDoc(cycleId);
  if (!cycle) throw new AppError('NOT_FOUND', 'Cycle not found');
  return cycle;
}

/** The survey version a cycle pinned for a type, or null when the cycle does not run it. */
export function pinnedSurveyId(cycle: CycleDoc, surveyType: SurveyType): string | null {
  const id = cycle.surveyVersions[surveyType];
  return id ? idString(id) : null;
}

/**
 * "The most recent SCORED cycle of the same type" (ARCHITECTURE §7): the
 * scored (or archived after scoring) cycle that also ran this survey type and
 * whose assessment window ended before this cycle's — chronological, so a
 * re-run of an old cycle never compares it with a newer one.
 */
export async function findPreviousScoredCycle(cycle: CycleDoc, surveyType: SurveyType): Promise<CycleDoc | null> {
  const candidates = await findCyclesByStatus(['SCORED', 'ARCHIVED']);
  const end = cycle.assessment.end.utc.getTime();
  let best: CycleDoc | null = null;
  for (const candidate of candidates) {
    if (candidate._id.equals(cycle._id) || candidate.scoredAt === null || pinnedSurveyId(candidate, surveyType) === null) continue;
    const candidateEnd = candidate.assessment.end.utc.getTime();
    if (candidateEnd >= end) continue;
    if (best === null || candidateEnd > best.assessment.end.utc.getTime()) best = candidate;
  }
  return best;
}

export interface ParticipantRef {
  acoId: string;
  airportId: string;
  surveyTypes: SurveyType[];
}

export async function loadParticipants(cycleId: string): Promise<ParticipantRef[]> {
  return (await listParticipants(cycleId)).map((dto) => ({ acoId: dto.acoId, airportId: dto.airportId, surveyTypes: [...dto.surveyTypes] }));
}

// --- settings --------------------------------------------------------------

export async function loadScoringSettings(): Promise<ScoringSettings> {
  const doc = await getSettingsDoc();
  return { minResponses: doc.scoring.minResponses, weightingMode: doc.scoring.weightingMode };
}

// --- surveys ---------------------------------------------------------------

/** The pinned survey as the engine sees it, plus what the service needs to publish rows by code. */
export interface LoadedSurvey {
  surveyId: string;
  structure: SurveyStructure;
  /** Node id (category, subcategory, question) → its stable code. */
  codeOf: ReadonlyMap<string, string>;
  /** Ids of the active questions, for the feedback distribution. */
  activeQuestionIds: ReadonlySet<string>;
}

type SurveyTreeDto = Awaited<ReturnType<typeof getSurveyTree>>;
type QuestionDto = SurveyTreeDto['categories'][number]['questions'][number];

function toEngineQuestion(question: QuestionDto): SurveyQuestion {
  return {
    id: question.id,
    code: question.code,
    text: question.text,
    mandatory: question.mandatory,
    active: question.active,
    ...(question.weightPct === null ? {} : { weightPct: question.weightPct }),
  };
}

export async function loadSurvey(surveyId: string): Promise<LoadedSurvey> {
  const tree = await getSurveyTree(surveyId);
  const codeOf = new Map<string, string>();
  const activeQuestionIds = new Set<string>();
  const questions = (items: readonly QuestionDto[]): SurveyQuestion[] =>
    items.map((question) => {
      codeOf.set(question.id, question.code);
      if (question.active) activeQuestionIds.add(question.id);
      return toEngineQuestion(question);
    });
  const structure: SurveyStructure = {
    categories: tree.categories.map((category) => {
      codeOf.set(category.id, category.code);
      return {
        id: category.id,
        code: category.code,
        name: category.name,
        order: category.order,
        ...(category.weightPct === null ? {} : { weightPct: category.weightPct }),
        subcategories: category.subcategories.map((sub) => {
          codeOf.set(sub.id, sub.code);
          return { id: sub.id, code: sub.code, name: sub.name, order: sub.order, questions: questions(sub.questions) };
        }),
        questions: questions(category.questions),
      };
    }),
  };
  return { surveyId: tree.survey.id, structure, codeOf, activeQuestionIds };
}

// --- assessments -----------------------------------------------------------

export interface SubmittedSet {
  assessments: SubmittedAssessment[];
  counts: ResponseCounts;
}

const RATINGS: readonly number[] = [1, 2, 3, 4, 5];

function toRating(value: number | null): Rating | null {
  return value !== null && RATINGS.includes(value) ? (value as Rating) : null;
}

/** Every SUBMITTED assessment (CUSTOMER and SELF) of one operator for one survey type. */
export async function loadSubmitted(cycleId: string, acoId: string, surveyType: SurveyType): Promise<SubmittedSet> {
  const views = (await listSubmitted(cycleId, acoId)).filter((view) => view.surveyType === surveyType);
  const counts: ResponseCounts = { customer: 0, self: 0, FF: 0, CB: 0 };
  const assessments = views.map((view): SubmittedAssessment => {
    if (view.kind === 'SELF') counts.self += 1;
    else {
      counts.customer += 1;
      if (view.customerType === 'FF') counts.FF += 1;
      if (view.customerType === 'CB') counts.CB += 1;
    }
    return {
      id: view.id,
      kind: view.kind,
      ...(view.customerType ? { customerType: view.customerType } : {}),
      answers: view.answers.map((answer) => ({ questionId: answer.questionId, rating: toRating(answer.rating), na: answer.na })),
    };
  });
  return { assessments, counts };
}

// --- organisations: the cycle's market-share snapshot -----------------------

/**
 * acoId → share for the airport in this cycle, from the snapshot the cycle
 * took at publish (`market_shares` rows keyed by `cycleId`, REQUIREMENTS §21).
 * Null when the airport has no snapshot, in which case the roll-up weighs its
 * operators equally. Read from the model because the market-share service
 * only answers a request context and the run has none.
 */
export async function loadShareSnapshot(cycleId: string, airportId: string): Promise<ReadonlyMap<string, number> | null> {
  const docs = await MarketShareModel.find({ cycleId: toId(cycleId, 'cycleId'), airportId: toId(airportId, 'airportId') }).lean<MarketShareDoc[]>();
  if (docs.length === 0) return null;
  return new Map(docs.map((doc) => [idString(doc.acoId), doc.sharePct]));
}

// --- airports --------------------------------------------------------------

export interface AirportRef {
  id: string;
  iata: string;
  name: string;
}

export async function loadAirports(ids: Iterable<string | Types.ObjectId>): Promise<Map<string, AirportRef>> {
  const docs = await findAirportsByIds(ids);
  return new Map([...docs.values()].map((doc) => [idString(doc._id), { id: idString(doc._id), iata: doc.iata, name: doc.name }]));
}
