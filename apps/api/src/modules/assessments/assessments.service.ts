import type { AssessmentState, AssessorKind, FormScope } from '@csq/contracts';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { TenantRepo } from '../../kernel/tenancy.js';
import { AssessmentModel, type AssessmentDoc, type CompletenessDoc } from './assessments.models.js';
import {
  assertAssignmentOpen,
  countSubmissions,
  loadOwnAssignment,
  recordProgress,
  recordSubmission,
} from './assessments.assignments.js';
import { loadInstrument, toInstrumentView, type InstrumentView } from './assessments.instruments.js';
import {
  applyOps,
  computeProgress,
  pruneAll,
  submitBlockers,
  toAnswerViews,
  type AnswerView,
  type SubmitBlocker,
} from './assessments.answers.js';
import type { AnswerOp } from './assessments.contracts.js';

/**
 * The runtime: open a return, save into it, submit it.
 *
 * Two rules are enforced here and nowhere else, because a client is the wrong
 * place for either. A submitted return is immutable, whatever the request says
 * its state is. And a return is complete when every applicable direction has a
 * rating, which is a server side count over the instrument rather than a flag
 * the form sends.
 */

const assessments = new TenantRepo<AssessmentDoc>(AssessmentModel);

const DUPLICATE_KEY = 11000;
/** Two tabs saving at once collide on the revision guard, not on the document. */
const MAX_SAVE_ATTEMPTS = 4;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY
  );
}

export interface AssessmentView {
  id: string;
  assignmentId: string;
  cycleId: string;
  acoOrgId: string;
  participationId: string | null;
  assessorUserId: string;
  assessorKind: AssessorKind;
  formScope: FormScope;
  instrumentId: string;
  state: AssessmentState;
  revision: number;
  startedAt: string;
  lastSavedAt: string;
  submittedAt: string | null;
  progress: CompletenessDoc;
  answers: AnswerView[];
}

function toView(doc: AssessmentDoc): AssessmentView {
  return {
    id: doc._id,
    assignmentId: doc.assignmentId,
    cycleId: doc.cycleId,
    acoOrgId: doc.acoOrgId,
    participationId: doc.participationId,
    assessorUserId: doc.assessorUserId,
    assessorKind: doc.assessorKind,
    formScope: doc.formScope,
    instrumentId: doc.instrumentId,
    state: doc.state,
    revision: doc.revision,
    startedAt: doc.startedAt.toISOString(),
    lastSavedAt: doc.lastSavedAt.toISOString(),
    submittedAt: doc.submittedAt?.toISOString() ?? null,
    progress: doc.completeness,
    answers: toAnswerViews(doc.answers),
  };
}

/** The assessor's own return. Anyone else's is answered as if it did not exist. */
async function loadOwn(assessmentId: string, userId: string): Promise<AssessmentDoc> {
  const doc = await assessments.findById(assessmentId).lean().exec();
  if (!doc || doc.assessorUserId !== userId) throw notFound('No such assessment');
  return doc;
}

async function findOpenDraft(assignmentId: string): Promise<AssessmentDoc | null> {
  return assessments.findOne({ assignmentId, state: 'DRAFT' }).lean().exec();
}

/**
 * Opens the return, or hands back the one already open. A customer or external
 * assessor gets one return per assignment; a self assessment may be started
 * again after an earlier one was submitted, because self assessment is
 * unlimited and never reaches the published score.
 */
export async function startAssessment(
  assignmentId: string,
  userId: string,
  now: Date,
): Promise<AssessmentView> {
  const assignment = await loadOwnAssignment(assignmentId, userId);
  assertAssignmentOpen(assignment, now);

  if (assignment.state === 'COMPLETED' && assignment.assessorKind !== 'SELF') {
    throw fail('ASSESSMENT_ALREADY_SUBMITTED', 'You have already submitted this assessment');
  }

  const open = await findOpenDraft(assignmentId);
  if (open) return toView(open);

  const instrument = await loadInstrument(assignment.instrumentId);
  const completeness = computeProgress(instrument, []);

  let created: AssessmentDoc;
  try {
    const doc = await assessments.create({
      assignmentId,
      cycleId: assignment.cycleId,
      acoOrgId: assignment.acoOrgId,
      participationId: assignment.participationId,
      assessorUserId: assignment.assessorUserId,
      assessorKind: assignment.assessorKind,
      formScope: assignment.formScope,
      instrumentId: assignment.instrumentId,
      state: 'DRAFT',
      answers: [],
      revision: 0,
      startedAt: now,
      lastSavedAt: now,
      submittedAt: null,
      openDraftKey: assignmentId,
      exclusiveSubmissionKey: null,
      completeness,
    });
    created = doc.toObject();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // two tabs opened the form at the same instant; the partial unique index on
    // openDraftKey decided which one is the draft
    const raced = await findOpenDraft(assignmentId);
    if (!raced) throw error;
    return toView(raced);
  }

  await recordProgress(assignmentId, created._id, completeness, now);
  return toView(created);
}

export async function readAssessment(assessmentId: string, userId: string): Promise<AssessmentView> {
  return toView(await loadOwn(assessmentId, userId));
}

/** The questions this particular return is answered against. */
export async function readAssessmentForm(
  assessmentId: string,
  userId: string,
): Promise<InstrumentView> {
  const doc = await loadOwn(assessmentId, userId);
  return toInstrumentView(await loadInstrument(doc.instrumentId));
}

export interface Readiness {
  progress: CompletenessDoc;
  blockers: SubmitBlocker[];
  canSubmit: boolean;
}

export async function readReadiness(assessmentId: string, userId: string): Promise<Readiness> {
  const doc = await loadOwn(assessmentId, userId);
  const instrument = await loadInstrument(doc.instrumentId);
  const answers = pruneAll(instrument, doc.answers);
  const blockers = submitBlockers(instrument, answers);
  return {
    progress: computeProgress(instrument, answers),
    blockers,
    canSubmit: doc.state === 'DRAFT' && blockers.length === 0,
  };
}

export interface SaveResult {
  id: string;
  revision: number;
  lastSavedAt: string;
  progress: CompletenessDoc;
  touched: string[];
  answers: AnswerView[];
}

/**
 * Autosave. The client sends what changed, never the document, and the write is
 * guarded by the revision it read: a save that lost the race is replayed onto
 * the version that won rather than overwriting it, so the other tab's edits
 * survive and the last write wins per leaf instead of per document.
 */
export async function patchAnswers(
  assessmentId: string,
  userId: string,
  ops: readonly AnswerOp[],
  now: Date,
): Promise<SaveResult> {
  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
    const doc = await loadOwn(assessmentId, userId);
    assertAmendable(doc);

    const assignment = await loadOwnAssignment(doc.assignmentId, userId);
    assertAssignmentOpen(assignment, now);

    const instrument = await loadInstrument(doc.instrumentId);
    const { answers, touched } = applyOps(instrument, doc.answers, ops, { now, userId });
    const completeness = computeProgress(instrument, answers);

    const updated = await assessments
      .findOneAndUpdate(
        { _id: assessmentId, state: 'DRAFT', revision: doc.revision },
        { $set: { answers, lastSavedAt: now, completeness }, $inc: { revision: 1 } },
      )
      .lean()
      .exec();

    if (updated) {
      await recordProgress(doc.assignmentId, assessmentId, completeness, now);
      return {
        id: updated._id,
        revision: updated.revision,
        lastSavedAt: updated.lastSavedAt.toISOString(),
        progress: updated.completeness,
        touched,
        answers: toAnswerViews(updated.answers),
      };
    }
  }

  throw conflict('This assessment is being saved from somewhere else. Reload and try again.');
}

function assertAmendable(doc: AssessmentDoc): void {
  if (doc.state === 'SUBMITTED') {
    throw fail('ASSESSMENT_ALREADY_SUBMITTED', 'This assessment has been submitted and cannot be changed');
  }
  if (doc.state === 'DISCARDED') {
    throw conflict('This draft was discarded');
  }
}

/**
 * Submitting is idempotent: pressing the button twice, or once on each of two
 * tabs, produces one submitted return and the same answer both times. The state
 * change is a conditional update on the document itself, so the database
 * decides the race rather than a read followed by a write.
 */
export async function submitAssessment(
  assessmentId: string,
  userId: string,
  now: Date,
): Promise<AssessmentView> {
  const doc = await loadOwn(assessmentId, userId);

  if (doc.state === 'DISCARDED') throw conflict('This draft was discarded');
  if (doc.state === 'SUBMITTED') return finishSubmission(doc);

  const assignment = await loadOwnAssignment(doc.assignmentId, userId);
  assertAssignmentOpen(assignment, now);

  const instrument = await loadInstrument(doc.instrumentId);
  // pruned once more here, because a rating changed after a follow-up was
  // written is exactly the case the assessor will not have noticed
  const answers = pruneAll(instrument, doc.answers);
  const blockers = submitBlockers(instrument, answers);
  if (blockers.length > 0) {
    throw fail(
      'VALIDATION_FAILED',
      'This assessment is not finished',
      blockers.map((b) => ({
        path: b.direction === null ? b.questionCode : `${b.questionCode}.${b.direction}`,
        message: b.message,
      })),
    );
  }

  const completeness = computeProgress(instrument, answers);
  const exclusiveSubmissionKey = doc.assessorKind === 'SELF' ? null : doc.assignmentId;

  let submitted: AssessmentDoc | null;
  try {
    submitted = await assessments
      .findOneAndUpdate(
        { _id: assessmentId, state: 'DRAFT', revision: doc.revision },
        {
          $set: {
            state: 'SUBMITTED',
            answers,
            completeness,
            submittedAt: now,
            lastSavedAt: now,
            openDraftKey: null,
            exclusiveSubmissionKey,
          },
          $inc: { revision: 1 },
        },
      )
      .lean()
      .exec();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    throw fail('ASSESSMENT_ALREADY_SUBMITTED', 'This assignment has already been answered');
  }

  if (!submitted) {
    const settled = await loadOwn(assessmentId, userId);
    if (settled.state === 'SUBMITTED') return finishSubmission(settled);
    throw conflict('This assessment changed while it was being submitted. Reload and try again.');
  }

  return finishSubmission(submitted);
}

async function finishSubmission(doc: AssessmentDoc): Promise<AssessmentView> {
  const submittedAt = doc.submittedAt ?? doc.lastSavedAt;
  const submissionCount = await countSubmissions(doc.assignmentId);
  await recordSubmission(doc.assignmentId, doc._id, doc.completeness, submittedAt, submissionCount);
  return toView(doc);
}

/** Abandons a draft. The record that it existed stays, the slot is freed. */
export async function discardAssessment(
  assessmentId: string,
  userId: string,
): Promise<AssessmentView> {
  const doc = await loadOwn(assessmentId, userId);
  assertAmendable(doc);

  const discarded = await assessments
    .findOneAndUpdate(
      { _id: assessmentId, state: 'DRAFT' },
      { $set: { state: 'DISCARDED', openDraftKey: null } },
    )
    .lean()
    .exec();
  if (!discarded) throw conflict('This draft changed while it was being discarded');
  return toView(discarded);
}

/**
 * A submitted return, read by someone running the cycle rather than by its
 * author. A draft is deliberately not readable this way: an operator reading a
 * customer's half-finished opinion of it is the thing that would stop customers
 * answering honestly, so an unsubmitted return is answered as not found.
 */
export async function readSubmission(assessmentId: string): Promise<AssessmentView> {
  const doc = await assessments.findOne({ _id: assessmentId, state: 'SUBMITTED' }).lean().exec();
  if (!doc) throw notFound('No such submitted assessment');
  return toView(doc);
}
