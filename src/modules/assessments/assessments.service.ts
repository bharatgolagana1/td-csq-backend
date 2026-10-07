import type { FilterQuery, Types } from 'mongoose';
import Papa from 'papaparse';

import type { LinkSession } from '../../core/auth/link.js';
import { assertScope } from '../../core/auth/rbac.js';
import type { RequestContext } from '../../core/auth/session.js';
import { requestContextOf, systemContext, type AnyContext } from '../../core/auth/system.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { emit, type CycleStatus, type SurveyType } from '../../core/events.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { pageOf, parseSort, skipLimit, type Page } from '../../core/pagination.js';
import { audit } from '../audit/audit.service.js';
import { findUserById } from '../identity/users.service.js';
import { findOrganisationsByIds } from '../organisations/organisations.service.js';
import { getSettingsDoc } from '../settings/settings.service.js';

import {
  formQuestionPlaces,
  mergeAnswers,
  ownScore,
  progressOf,
  readinessOf,
  validateAnswers,
  type AnswerInput,
  type AssessmentForm,
} from './assessments.form.js';
import { assessorView, maskEmail, revealsIdentity, type AssessorIdentity } from './assessments.identity.js';
import { AssessmentModel, type AssessmentDoc, type AssessmentKind, type CustomerType, type StoredAnswer } from './assessments.model.js';
import type {
  AnswerDto,
  AssessmentDetailDto,
  AssessmentDto,
  AssessmentFormDto,
  AssessmentListQuery,
  DraftDto,
  ExportQuery,
  HistoryRowDto,
  PatchAnswersResult,
  ReadinessDto,
  SelfAssessmentDto,
} from './assessments.schemas.js';
import { customerForm, customerRef, cycleRef, participantRef, selfForm, type CycleRef } from './assessments.sources.js';

/** A self-assessment may be opened, saved and submitted while the cycle is in one of these. */
export const SELF_OPEN_STATUSES: readonly CycleStatus[] = ['SAMPLING_OPEN', 'SAMPLING_CLOSED', 'ASSESSMENT_OPEN'];

// --- views ------------------------------------------------------------------

function toAnswerDto(answer: StoredAnswer): AnswerDto {
  return { questionId: answer.questionId, rating: answer.rating, na: answer.na, comment: answer.comment, followUp: [...answer.followUp] };
}

export function toAssessmentDto(doc: AssessmentDoc): AssessmentDto {
  return {
    id: idString(doc._id),
    cycleId: idString(doc.cycleId),
    acoId: idString(doc.acoId),
    airportId: idString(doc.airportId),
    surveyId: doc.surveyId,
    surveyType: doc.surveyType,
    kind: doc.kind,
    customerType: doc.customerType,
    invitationId: doc.invitationId ? idString(doc.invitationId) : null,
    userId: doc.userId ? idString(doc.userId) : null,
    status: doc.status,
    progress: progressOf(doc.answeredCount, doc.questionCount),
    startedAt: doc.startedAt.toISOString(),
    lastSavedAt: doc.lastSavedAt?.toISOString() ?? null,
    submittedAt: doc.submittedAt?.toISOString() ?? null,
  };
}

async function requireAssessment(id: string): Promise<AssessmentDoc> {
  const doc = await AssessmentModel.findById(toId(id, 'assessmentId')).lean<AssessmentDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Assessment not found');
  return doc;
}

/** The form this assessment answers: the customer's stakeholder form, or every active question for SELF. */
async function formFor(doc: AssessmentDoc): Promise<AssessmentForm> {
  if (doc.kind === 'SELF') return selfForm(doc.surveyId);
  if (doc.customerType === null) throw new AppError('INTERNAL', 'Customer assessment without a customer type');
  return customerForm(doc.surveyId, doc.customerType);
}

function pinnedSurveyId(cycle: CycleRef, surveyType: SurveyType): string {
  const surveyId = cycle.surveyVersions[surveyType];
  if (!surveyId) throw new AppError('PRECONDITION_FAILED', `Cycle ${cycle.code} has no published ${surveyType} survey`, { surveyType });
  return surveyId;
}

/** The surveys' form unchanged, with the assessment and its progress against that form. */
function formView(doc: AssessmentDoc, form: AssessmentForm): AssessmentFormDto {
  const readiness = readinessOf(form, doc.answers);
  return { assessment: toAssessmentDto(doc), ...form, progress: progressOf(readiness.answered, readiness.total) };
}

// --- participant flow (called by the invitations public routes) ---------------

/** What the invitations module hands over: a lean invitation document or its DTO. */
export interface InvitationForAssessment {
  _id?: Types.ObjectId | string;
  id?: string;
  cycleId: Types.ObjectId | string;
  acoId: Types.ObjectId | string;
  customerId: Types.ObjectId | string;
  surveyType: SurveyType;
}

function invitationIdOf(invitation: InvitationForAssessment): string {
  const id = invitation._id ?? invitation.id;
  if (id === undefined) throw new AppError('INTERNAL', 'Invitation without an id');
  return idString(id);
}

/**
 * One assessment per invitation, created on first access and returned as-is
 * afterwards. Pins the survey version the cycle published for the survey
 * type and the customer's stakeholder type (FF / CB), which decides the form.
 */
export async function getOrCreateForInvitation(invitation: InvitationForAssessment): Promise<AssessmentDto> {
  const invitationId = toId(invitationIdOf(invitation), 'invitationId');
  const existing = await AssessmentModel.findOne({ invitationId }).lean<AssessmentDoc>();
  if (existing) return toAssessmentDto(existing);

  const cycleId = idString(invitation.cycleId);
  const acoId = idString(invitation.acoId);
  const customerId = idString(invitation.customerId);
  const cycle = await cycleRef(systemContext(`assessments: invitation ${idString(invitationId)}`), cycleId);
  const surveyId = pinnedSurveyId(cycle, invitation.surveyType);
  const participant = await participantRef(cycleId, acoId);
  if (!participant) throw new AppError('PRECONDITION_FAILED', 'Operator is not a participant of this cycle', { cycleId, acoId });
  const customer = await customerRef(acoId, customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found');
  const form = await customerForm(surveyId, customer.type);

  const doc = await AssessmentModel.findOneAndUpdate(
    { invitationId },
    {
      $setOnInsert: {
        cycleId: toId(cycleId),
        acoId: toId(acoId),
        airportId: toId(participant.airportId),
        surveyId,
        surveyType: invitation.surveyType,
        kind: 'CUSTOMER',
        customerId: toId(customerId),
        customerType: customer.type,
        invitationId,
        userId: null,
        status: 'DRAFT',
        answers: [],
        answeredCount: 0,
        questionCount: readinessOf(form, []).total,
        startedAt: new Date(),
        lastSavedAt: null,
        submittedAt: null,
      },
    },
    { upsert: true, new: true },
  ).lean<AssessmentDoc | null>();
  if (!doc) throw new AppError('INTERNAL', 'Assessment upsert returned nothing');
  return toAssessmentDto(doc);
}

/** The form for the assessment's stakeholder type plus its progress — what the web form renders. */
export async function getForm(assessmentId: string): Promise<AssessmentFormDto> {
  const doc = await requireAssessment(assessmentId);
  return formView(doc, await formFor(doc));
}

export async function getDraft(assessmentId: string): Promise<DraftDto> {
  const doc = await requireAssessment(assessmentId);
  return {
    id: idString(doc._id),
    status: doc.status,
    answers: doc.answers.map(toAnswerDto),
    progress: progressOf(doc.answeredCount, doc.questionCount),
    lastSavedAt: doc.lastSavedAt?.toISOString() ?? null,
    submittedAt: doc.submittedAt?.toISOString() ?? null,
  };
}

/**
 * Autosave: validates each answer against the form (§7 "Form rules"), merges
 * by question, recounts and returns the progress. 412 once submitted.
 */
export async function patchAnswers(assessmentId: string, answers: readonly AnswerInput[]): Promise<PatchAnswersResult> {
  const doc = await requireAssessment(assessmentId);
  if (doc.status === 'SUBMITTED') throw new AppError('PRECONDITION_FAILED', 'Assessment already submitted; answers are read-only');
  const form = await formFor(doc);
  const validation = validateAnswers(form, answers);
  if (!validation.ok) throw new AppError('VALIDATION', 'Invalid answers', { issues: validation.issues });

  const merged = mergeAnswers(doc.answers, validation.answers);
  const readiness = readinessOf(form, merged);
  const now = new Date();
  const updated = await AssessmentModel.findOneAndUpdate(
    { _id: doc._id, status: 'DRAFT' },
    { $set: { answers: merged, answeredCount: readiness.answered, questionCount: readiness.total, lastSavedAt: now } },
    { new: true },
  ).lean<AssessmentDoc | null>();
  if (!updated) throw new AppError('PRECONDITION_FAILED', 'Assessment already submitted; answers are read-only');
  return { ...progressOf(readiness.answered, readiness.total), lastSavedAt: now.toISOString() };
}

export async function readiness(assessmentId: string): Promise<ReadinessDto> {
  const doc = await requireAssessment(assessmentId);
  return readinessOf(await formFor(doc), doc.answers);
}

function isLinkSession(actor: RequestContext | LinkSession): actor is LinkSession {
  return 'audience' in actor;
}

/** The actor may act on this assessment: a participant link on its own CUSTOMER assessment; an operator on its own. */
function assertActorMayAccess(actor: RequestContext | LinkSession, doc: AssessmentDoc): void {
  if (isLinkSession(actor)) {
    const claimed = actor.claims['asg'];
    const ok = actor.audience === 'participant' && doc.kind === 'CUSTOMER' && (typeof claimed !== 'string' || claimed === idString(doc._id));
    if (!ok) throw new AppError('NOT_FOUND', 'Assessment not found');
    return;
  }
  const visible =
    actor.scope.kind === 'PLATFORM' || (actor.scope.kind === 'ACO' && actor.scope.acoId === idString(doc.acoId));
  if (!visible) throw new AppError('NOT_FOUND', 'Assessment not found');
}

/**
 * Locks the assessment: 412 unless every form question is answered; sets
 * SUBMITTED + submittedAt; emits `assessment.submitted` inside the same
 * transaction (invitations and cycles react; a failing listener rolls the
 * submit back); audits `assessment.submitted`.
 */
export async function submit(actor: RequestContext | LinkSession, assessmentId: string): Promise<AssessmentDto> {
  const doc = await requireAssessment(assessmentId);
  assertActorMayAccess(actor, doc);
  if (doc.status === 'SUBMITTED') throw new AppError('PRECONDITION_FAILED', 'Assessment already submitted');
  const ready = readinessOf(await formFor(doc), doc.answers);
  if (!ready.complete) {
    throw new AppError('PRECONDITION_FAILED', `Answer every question before submitting (${ready.missing.length} left)`, { missing: ready.missing });
  }

  const ctx: AnyContext = isLinkSession(actor)
    ? systemContext(`participant link: invitation ${doc.invitationId ? idString(doc.invitationId) : '?'}`)
    : actor;
  const now = new Date();
  const updated = await withTransaction(async (session) => {
    const submitted = await AssessmentModel.findOneAndUpdate(
      { _id: doc._id, status: 'DRAFT' },
      { $set: { status: 'SUBMITTED', submittedAt: now, answeredCount: ready.answered, questionCount: ready.total } },
      { new: true, session },
    ).lean<AssessmentDoc | null>();
    if (!submitted) throw new AppError('PRECONDITION_FAILED', 'Assessment already submitted');
    await emit(
      'assessment.submitted',
      {
        assessmentId: idString(doc._id),
        cycleId: idString(doc.cycleId),
        acoId: idString(doc.acoId),
        kind: doc.kind,
        surveyType: doc.surveyType,
        ...(doc.invitationId ? { invitationId: idString(doc.invitationId) } : {}),
      },
      { ctx, session },
    );
    return submitted;
  });

  await audit(requestContextOf(ctx), {
    action: 'assessment.submitted',
    entity: 'assessment',
    entityId: idString(doc._id),
    after: {
      kind: doc.kind,
      surveyType: doc.surveyType,
      cycleId: idString(doc.cycleId),
      invitationId: doc.invitationId ? idString(doc.invitationId) : null,
      answeredCount: ready.answered,
      questionCount: ready.total,
      submittedAt: now.toISOString(),
    },
    orgId: idString(doc.acoId),
  });
  return toAssessmentDto(updated);
}

// --- self assessment --------------------------------------------------------

/**
 * The operator's SELF assessment for a cycle and survey type, created on
 * first access by the signed-in user. Only while the cycle is between
 * SAMPLING_OPEN and ASSESSMENT_OPEN, and only for a survey type the
 * operator takes part in.
 */
async function getOrCreateSelfDoc(ctx: RequestContext, cycleId: string, surveyType: SurveyType): Promise<AssessmentDoc> {
  assertScope(ctx, 'ACO');
  const acoId = ctx.org.id;
  const cycle = await cycleRef(ctx, cycleId);
  const participant = await participantRef(cycleId, acoId);
  if (!participant) throw new AppError('NOT_FOUND', 'Cycle not found');
  if (!participant.surveyTypes.includes(surveyType)) {
    throw new AppError('PRECONDITION_FAILED', `${ctx.org.code} does not take part in the ${surveyType} survey of this cycle`, { surveyType });
  }
  if (!SELF_OPEN_STATUSES.includes(cycle.status)) {
    throw new AppError('PRECONDITION_FAILED', `Self-assessment is not open while the cycle is ${cycle.status}`, { status: cycle.status });
  }
  const surveyId = pinnedSurveyId(cycle, surveyType);
  const key = { cycleId: toId(cycleId), acoId: toId(acoId), surveyType, kind: 'SELF' as const };
  const existing = await AssessmentModel.findOne(key).lean<AssessmentDoc>();
  if (existing) return existing;

  const form = await selfForm(surveyId);
  const doc = await AssessmentModel.findOneAndUpdate(
    key,
    {
      $setOnInsert: {
        ...key,
        airportId: toId(participant.airportId),
        surveyId,
        customerId: null,
        customerType: null,
        invitationId: null,
        userId: toId(ctx.user.id),
        status: 'DRAFT',
        answers: [],
        answeredCount: 0,
        questionCount: readinessOf(form, []).total,
        startedAt: new Date(),
        lastSavedAt: null,
        submittedAt: null,
      },
    },
    { upsert: true, new: true },
  ).lean<AssessmentDoc | null>();
  if (!doc) throw new AppError('INTERNAL', 'Self-assessment upsert returned nothing');
  return doc;
}

export async function getOrCreateSelf(ctx: RequestContext, cycleId: string, surveyType: SurveyType): Promise<AssessmentDto> {
  return toAssessmentDto(await getOrCreateSelfDoc(ctx, cycleId, surveyType));
}

/** `GET /assessments/self/:cycleId/:surveyType`: form, progress and the saved answers. */
export async function getSelfAssessment(ctx: RequestContext, cycleId: string, surveyType: SurveyType): Promise<SelfAssessmentDto> {
  const doc = await getOrCreateSelfDoc(ctx, cycleId, surveyType);
  return { ...formView(doc, await selfForm(doc.surveyId)), answers: doc.answers.map(toAnswerDto) };
}

export async function patchSelfAnswers(
  ctx: RequestContext,
  cycleId: string,
  surveyType: SurveyType,
  answers: readonly AnswerInput[],
): Promise<PatchAnswersResult> {
  const doc = await getOrCreateSelfDoc(ctx, cycleId, surveyType);
  return patchAnswers(idString(doc._id), answers);
}

export async function submitSelf(ctx: RequestContext, cycleId: string, surveyType: SurveyType): Promise<AssessmentDto> {
  const doc = await getOrCreateSelfDoc(ctx, cycleId, surveyType);
  return submit(ctx, idString(doc._id));
}

// --- for scoring ------------------------------------------------------------

/** A SUBMITTED assessment as the scoring engine consumes it (`SubmittedAssessment` plus its identifiers). */
export interface SubmittedAssessmentView {
  id: string;
  cycleId: string;
  acoId: string;
  surveyType: SurveyType;
  kind: AssessmentKind;
  customerId: string | null;
  customerType?: CustomerType;
  submittedAt: string;
  answers: AnswerDto[];
}

export async function listSubmitted(cycleId: string, acoId: string, kind?: AssessmentKind): Promise<SubmittedAssessmentView[]> {
  const filter: FilterQuery<AssessmentDoc> = { cycleId: toId(cycleId), acoId: toId(acoId), status: 'SUBMITTED' };
  if (kind) filter.kind = kind;
  const docs = await AssessmentModel.find(filter).sort({ submittedAt: 1 }).lean<AssessmentDoc[]>();
  return docs.map((doc) => ({
    id: idString(doc._id),
    cycleId: idString(doc.cycleId),
    acoId: idString(doc.acoId),
    surveyType: doc.surveyType,
    kind: doc.kind,
    customerId: doc.customerId ? idString(doc.customerId) : null,
    ...(doc.customerType ? { customerType: doc.customerType } : {}),
    submittedAt: doc.submittedAt?.toISOString() ?? doc.updatedAt.toISOString(),
    answers: doc.answers.map(toAnswerDto),
  }));
}

// --- signed-in history ------------------------------------------------------

/** Assessments the caller may see: PLATFORM all; ACO its own; AIRPORT those of operators at its airport. */
function scopeFilter(ctx: RequestContext): FilterQuery<AssessmentDoc> {
  switch (ctx.scope.kind) {
    case 'PLATFORM':
      return {};
    case 'ACO':
      return { acoId: toId(ctx.scope.acoId) };
    case 'AIRPORT':
      return { airportId: toId(ctx.scope.airportId) };
  }
}

const UNKNOWN_CYCLE = (id: string): HistoryRowDto['cycle'] => ({ id, code: '?', name: 'Unknown cycle' });

async function cycleSummaries(ctx: RequestContext, docs: readonly AssessmentDoc[]): Promise<Map<string, HistoryRowDto['cycle']>> {
  const ids = [...new Set(docs.map((doc) => idString(doc.cycleId)))];
  const refs = await Promise.all(
    ids.map(async (id) => {
      try {
        const cycle = await cycleRef(ctx, id);
        return { id, code: cycle.code, name: cycle.name };
      } catch (error) {
        if (error instanceof AppError && error.code === 'NOT_FOUND') return UNKNOWN_CYCLE(id);
        throw error;
      }
    }),
  );
  return new Map(refs.map((ref) => [ref.id, ref]));
}

async function assessorIdentity(doc: AssessmentDoc): Promise<AssessorIdentity> {
  if (doc.kind === 'SELF') {
    const user = doc.userId ? await findUserById(doc.userId) : null;
    return { name: user?.name ?? null, email: user?.email ?? null };
  }
  const customer = doc.customerId ? await customerRef(idString(doc.acoId), idString(doc.customerId)) : null;
  return { name: customer?.contactPerson ?? customer?.name ?? null, email: customer?.email ?? null };
}

async function toHistoryRows(ctx: RequestContext, docs: readonly AssessmentDoc[]): Promise<HistoryRowDto[]> {
  const reveal = revealsIdentity(ctx, await getSettingsDoc());
  const [cycles, operators, identities] = await Promise.all([
    cycleSummaries(ctx, docs),
    findOrganisationsByIds(docs.map((doc) => doc.acoId)),
    Promise.all(docs.map(assessorIdentity)),
  ]);
  return docs.map((doc, index) => {
    const id = idString(doc._id);
    const acoId = idString(doc.acoId);
    const operator = operators.get(acoId);
    const identity = identities[index] ?? { name: null, email: null };
    const revealed = doc.kind === 'SELF' || reveal;
    const assessor = assessorView(identity, revealed);
    return {
      id,
      cycle: cycles.get(idString(doc.cycleId)) ?? UNKNOWN_CYCLE(idString(doc.cycleId)),
      operator: { id: acoId, code: operator?.code ?? '?', name: operator?.name ?? 'Unknown operator' },
      kind: doc.kind,
      surveyType: doc.surveyType,
      customerType: doc.customerType,
      customerId: revealed && doc.customerId ? idString(doc.customerId) : null,
      assessorName: assessor.name,
      assessorEmailMasked: identity.email === null ? null : maskEmail(identity.email),
      assessor,
      status: doc.status,
      progress: progressOf(doc.answeredCount, doc.questionCount),
      startedAt: doc.startedAt.toISOString(),
      submittedAt: doc.submittedAt?.toISOString() ?? null,
      score: ownScore(doc.answers),
    };
  });
}

const SORTABLE = ['startedAt', 'submittedAt', 'status', 'kind', 'surveyType', 'customerType', 'createdAt'] as const;

export async function listAssessments(ctx: RequestContext, query: AssessmentListQuery): Promise<Page<HistoryRowDto>> {
  const requested: FilterQuery<AssessmentDoc> = {};
  if (query.cycleId) requested.cycleId = toId(query.cycleId);
  if (query.acoId) requested.acoId = toId(query.acoId);
  if (query.kind) requested.kind = query.kind;
  if (query.status) requested.status = query.status;
  if (query.customerType) requested.customerType = query.customerType;
  if (query.surveyType) requested.surveyType = query.surveyType;
  const filter = and<AssessmentDoc>(scopeFilter(ctx), requested);
  const sort = parseSort(query.sort, SORTABLE, '-startedAt');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    AssessmentModel.find(filter).sort(sort).skip(skip).limit(limit).lean<AssessmentDoc[]>(),
    AssessmentModel.countDocuments(filter),
  ]);
  return pageOf(await toHistoryRows(ctx, docs), total, query);
}

async function requireVisibleAssessment(ctx: RequestContext, id: string): Promise<AssessmentDoc> {
  const doc = await AssessmentModel.findOne(and<AssessmentDoc>(scopeFilter(ctx), { _id: toId(id) })).lean<AssessmentDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Assessment not found');
  return doc;
}

function detailAnswers(form: AssessmentForm, answers: readonly StoredAnswer[]): AssessmentDetailDto['answers'] {
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  return formQuestionPlaces(form).map(({ question, category, subcategory }) => {
    const answer = byQuestion.get(question.id);
    return {
      questionId: question.id,
      code: question.code,
      text: question.text,
      category: { id: category.id, code: category.code, name: category.name },
      subcategory: subcategory ? { id: subcategory.id, code: subcategory.code, name: subcategory.name } : null,
      rating: answer?.rating ?? null,
      na: answer?.na ?? false,
      comment: answer?.comment ?? null,
      followUp: answer ? [...answer.followUp] : [],
    };
  });
}

/** The read-only return: every form question with its answer; identity masked per the setting. */
export async function getAssessment(ctx: RequestContext, id: string): Promise<AssessmentDetailDto> {
  const doc = await requireVisibleAssessment(ctx, id);
  const [row] = await toHistoryRows(ctx, [doc]);
  if (!row) throw new AppError('INTERNAL', 'History row missing');
  const form = await formFor(doc);
  return { ...row, survey: form.survey, answers: detailAnswers(form, doc.answers) };
}

// --- export -----------------------------------------------------------------

export const EXPORT_COLUMNS = [
  'assessmentId',
  'cycle',
  'operator',
  'kind',
  'surveyType',
  'customerType',
  'assessorName',
  'assessorEmail',
  'status',
  'submittedAt',
  'score',
  'category',
  'subcategory',
  'questionCode',
  'question',
  'rating',
  'na',
  'comment',
  'followUp',
] as const;

export interface CsvExport {
  fileName: string;
  csv: string;
}

/** One CSV row per assessment and form question (long format), identities masked per the setting; a cycle out of scope is 404. */
export async function exportAssessmentsCsv(ctx: RequestContext, query: ExportQuery): Promise<CsvExport> {
  const cycle = await cycleRef(ctx, query.cycleId);
  const requested: FilterQuery<AssessmentDoc> = { cycleId: toId(query.cycleId) };
  if (query.acoId) requested.acoId = toId(query.acoId);
  if (query.kind) requested.kind = query.kind;
  if (query.status) requested.status = query.status;
  const docs = await AssessmentModel.find(and<AssessmentDoc>(scopeFilter(ctx), requested)).sort({ startedAt: 1 }).lean<AssessmentDoc[]>();
  const rows = await toHistoryRows(ctx, docs);

  const forms = new Map<string, AssessmentForm>();
  const data: (string | number | boolean | null)[][] = [];
  for (const [index, doc] of docs.entries()) {
    const row = rows[index];
    if (!row) continue;
    const formKey = `${doc.kind}:${doc.surveyId}:${doc.customerType ?? ''}`;
    let form = forms.get(formKey);
    if (!form) {
      form = await formFor(doc);
      forms.set(formKey, form);
    }
    for (const line of detailAnswers(form, doc.answers)) {
      data.push([
        row.id,
        row.cycle.code,
        row.operator.code,
        row.kind,
        row.surveyType,
        row.customerType,
        row.assessor.name,
        row.assessor.email,
        row.status,
        row.submittedAt,
        row.score,
        line.category.code,
        line.subcategory?.code ?? null,
        line.code,
        line.text,
        line.rating,
        line.na,
        line.comment,
        line.followUp.join(' | '),
      ]);
    }
  }
  return {
    fileName: `assessments-${cycle.code.replace(/[^A-Za-z0-9_-]+/g, '_')}.csv`,
    csv: Papa.unparse({ fields: [...EXPORT_COLUMNS], data }, { newline: '\n' }),
  };
}
