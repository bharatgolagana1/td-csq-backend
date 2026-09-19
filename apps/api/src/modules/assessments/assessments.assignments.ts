import mongoose from 'mongoose';
import { z } from 'zod';
import { isOpen, validateOrdering, type CycleWindows } from '@csq/core';
import { AssessorKind, type FormScope } from '@csq/contracts';
import { conflict, fail, forbidden, notFound } from '../../kernel/errors.js';
import { TenantRepo, type TenantFilter } from '../../kernel/tenancy.js';
import {
  AssessmentModel,
  AssignmentModel,
  type AssessmentDoc,
  type AssignmentDoc,
  type BoundaryDoc,
  type CompletenessDoc,
  type WindowsDoc,
} from './assessments.models.js';
import type {
  AssignmentQuery,
  AssignmentState,
  BoundaryInput,
  CreateAssignment,
  WindowsInput,
  WorklistQuery,
} from './assessments.contracts.js';
import { loadInstrument } from './assessments.instruments.js';

/**
 * An assignment is the entitlement to answer: this assessor, this terminal,
 * this cycle. Nothing else lets a return be opened, which is why the runtime
 * asks this file rather than deciding for itself.
 *
 * No function here takes an organisation id. The tenancy plugin supplies it
 * from the request scope.
 */

const assignments = new TenantRepo<AssignmentDoc>(AssignmentModel);
const assessments = new TenantRepo<AssessmentDoc>(AssessmentModel);

const EMPTY_COMPLETENESS: CompletenessDoc = {
  applicableDirections: 0,
  answeredDirections: 0,
  percentBp: 0,
};

/**
 * Reads the wall time an instant actually falls at in a zone. Used to check a
 * boundary against itself rather than to resolve one: resolution is the cycles
 * module's job, and two resolvers that drift would be worse than one.
 */
function wallTimeIn(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

function toBoundary(name: string, input: BoundaryInput): BoundaryDoc {
  const utc = new Date(input.utc);
  if (Number.isNaN(utc.getTime())) {
    throw fail('VALIDATION_FAILED', `${name}.utc is not an instant`, [
      { path: `windows.${name}.utc`, message: 'not a valid date and time' },
    ]);
  }

  let actual: string;
  try {
    actual = wallTimeIn(utc, input.tz);
  } catch {
    throw fail('VALIDATION_FAILED', `${name}.tz is not a zone this platform knows`, [
      { path: `windows.${name}.tz`, message: `${input.tz} is not an IANA zone` },
    ]);
  }

  // a wall time that does not match its own instant means somebody resolved it
  // somewhere else, and a cycle that opens an hour early is not recoverable
  // after the invitations have gone out
  if (actual !== input.wall.slice(0, 16)) {
    throw fail('VALIDATION_FAILED', `${name} does not fall at ${input.wall} in ${input.tz}`, [
      { path: `windows.${name}`, message: `that instant is ${actual} in ${input.tz}` },
    ]);
  }

  return { wall: input.wall, tz: input.tz, utc };
}

export function toWindowsDoc(input: WindowsInput): WindowsDoc {
  const windows: WindowsDoc = {
    samplingOpens: toBoundary('samplingOpens', input.samplingOpens),
    samplingCloses: toBoundary('samplingCloses', input.samplingCloses),
    assessmentOpens: toBoundary('assessmentOpens', input.assessmentOpens),
    assessmentCloses: toBoundary('assessmentCloses', input.assessmentCloses),
  };

  const problems = validateOrdering(toCycleWindows(windows));
  if (problems.length > 0) {
    throw fail(
      'VALIDATION_FAILED',
      'These windows cannot be ordered',
      problems.map((p) => ({ path: 'windows', message: p })),
    );
  }
  return windows;
}

function toCycleWindows(doc: WindowsDoc): CycleWindows {
  return {
    samplingOpens: doc.samplingOpens,
    samplingCloses: doc.samplingCloses,
    assessmentOpens: doc.assessmentOpens,
    assessmentCloses: doc.assessmentCloses,
  };
}

export type WindowState = 'ALWAYS_OPEN' | 'NOT_YET_OPEN' | 'OPEN' | 'CLOSED';

/**
 * A self assessment is not gated at all: an operator may grade itself as often
 * as it likes and whenever it likes, because that number never reaches the
 * published score. Everyone else answers inside the cycle window, and not
 * before their own assignment becomes active, which is later than the window
 * opening for a customer sampled late.
 */
export function windowStateOf(assignment: AssignmentDoc, now: Date): WindowState {
  if (assignment.assessorKind === 'SELF') return 'ALWAYS_OPEN';
  const windows = assignment.windows;
  if (!windows) return 'CLOSED';
  if (now < assignment.activeFrom) return 'NOT_YET_OPEN';
  if (isOpen(toCycleWindows(windows), 'ASSESSMENT', now)) return 'OPEN';
  return now < windows.assessmentOpens.utc ? 'NOT_YET_OPEN' : 'CLOSED';
}

export function assertAssignmentOpen(assignment: AssignmentDoc, now: Date): void {
  if (assignment.state === 'REVOKED') {
    throw forbidden('This assignment has been withdrawn');
  }
  if (assignment.state === 'DECLINED') {
    throw forbidden('This assignment was declined. Ask the operator to issue it again.');
  }

  switch (windowStateOf(assignment, now)) {
    case 'ALWAYS_OPEN':
    case 'OPEN':
      return;
    case 'NOT_YET_OPEN':
      throw fail('WINDOW_NOT_OPEN', 'This assessment has not opened yet');
    case 'CLOSED':
      throw fail('WINDOW_CLOSED', 'This assessment window has closed');
  }
}

export interface AssignmentView {
  id: string;
  cycleId: string;
  acoOrgId: string;
  participationId: string | null;
  assessorUserId: string;
  assessorKind: AssessorKind;
  formScope: FormScope;
  instrumentId: string;
  state: AssignmentState;
  windowState: WindowState;
  window: { opensAt: string; closesAt: string; tz: string } | null;
  activeFrom: string;
  startedAt: string | null;
  submittedAt: string | null;
  submissionCount: number;
  currentAssessmentId: string | null;
  completeness: CompletenessDoc;
  closedReason: string | null;
}

export function toAssignmentView(doc: AssignmentDoc, now: Date): AssignmentView {
  return {
    id: doc._id,
    cycleId: doc.cycleId,
    acoOrgId: doc.acoOrgId,
    participationId: doc.participationId,
    assessorUserId: doc.assessorUserId,
    assessorKind: doc.assessorKind,
    formScope: doc.formScope,
    instrumentId: doc.instrumentId,
    state: doc.state,
    windowState: windowStateOf(doc, now),
    window: doc.windows
      ? {
          opensAt: doc.windows.assessmentOpens.utc.toISOString(),
          closesAt: doc.windows.assessmentCloses.utc.toISOString(),
          tz: doc.windows.assessmentOpens.tz,
        }
      : null,
    activeFrom: doc.activeFrom.toISOString(),
    startedAt: doc.startedAt?.toISOString() ?? null,
    submittedAt: doc.submittedAt?.toISOString() ?? null,
    submissionCount: doc.submissionCount,
    currentAssessmentId: doc.currentAssessmentId,
    completeness: doc.completeness,
    closedReason: doc.closedReason,
  };
}

/** The slice of an account this module reads. Anything else is not its business. */
const AssessorRow = z.object({ status: z.string().min(1) });

interface UserRow {
  _id: string;
  status: string;
}

/**
 * Identity belongs to the kernel and sits outside tenancy, so this is a read of
 * somebody else's collection: by id, one field, and validated rather than
 * trusted. It goes through the connection rather than importing the kernel's
 * User model because that model is registered unguarded, and a second module
 * importing it makes two test files in one process collide on the registration.
 */
async function assertAssessorExists(userId: string): Promise<void> {
  const row = await mongoose.connection
    .collection<UserRow>('users')
    .findOne({ _id: userId }, { projection: { status: 1 } });

  if (row === null) {
    throw fail('VALIDATION_FAILED', 'That assessor does not exist', [
      { path: 'assessorUserId', message: 'unknown account' },
    ]);
  }

  const parsed = AssessorRow.safeParse(row);
  if (!parsed.success || parsed.data.status !== 'ACTIVE') {
    throw fail('VALIDATION_FAILED', 'That account cannot be assigned work', [
      { path: 'assessorUserId', message: 'the account is not active' },
    ]);
  }
}

/**
 * Creating an assignment is idempotent on the cycle, the terminal and the
 * assessor, because the caller is a sampling batch that may well be replayed.
 * A second call refreshes the window and revives a withdrawn assignment rather
 * than creating a duplicate the assessor would see twice.
 */
export async function createAssignment(input: CreateAssignment, now: Date): Promise<AssignmentView> {
  const instrument = await loadInstrument(input.instrumentId);
  if (instrument.formScope !== input.formScope) {
    throw fail('VALIDATION_FAILED', 'That instrument is for the other form', [
      { path: 'instrumentId', message: `instrument is ${instrument.formScope}, assignment is ${input.formScope}` },
    ]);
  }

  await assertAssessorExists(input.assessorUserId);

  const windows = input.windows === null ? null : toWindowsDoc(input.windows);
  const activeFrom = resolveActiveFrom(input.activeFrom, windows, now);
  if (windows && activeFrom >= windows.assessmentCloses.utc) {
    throw fail('VALIDATION_FAILED', 'This assessor would become active after the window closes', [
      { path: 'activeFrom', message: 'must be before the assessment window closes' },
    ]);
  }

  const existing = await assignments
    .findOne({ cycleId: input.cycleId, acoOrgId: input.acoOrgId, assessorUserId: input.assessorUserId })
    .lean()
    .exec();

  if (!existing) {
    const created = await assignments.create({
      cycleId: input.cycleId,
      acoOrgId: input.acoOrgId,
      participationId: input.participationId,
      assessorUserId: input.assessorUserId,
      assessorKind: input.assessorKind,
      formScope: input.formScope,
      instrumentId: input.instrumentId,
      state: 'PENDING',
      windows,
      activeFrom,
      startedAt: null,
      submittedAt: null,
      submissionCount: 0,
      currentAssessmentId: null,
      completeness: EMPTY_COMPLETENESS,
      closedReason: null,
    });
    return toAssignmentView(created.toObject(), now);
  }

  if (existing.assessorKind !== input.assessorKind) {
    throw conflict(
      `${input.assessorUserId} is already assigned to this terminal as ${existing.assessorKind}`,
    );
  }
  if (existing.state === 'COMPLETED' && existing.assessorKind !== 'SELF') {
    // already answered: re-issuing must not reopen a submitted return
    return toAssignmentView(existing, now);
  }
  if (existing.instrumentId !== input.instrumentId && existing.currentAssessmentId !== null) {
    throw conflict('This assessor has already started answering the instrument they were given');
  }

  const revived = existing.state === 'REVOKED' || existing.state === 'DECLINED';
  const updated = await assignments
    .findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          instrumentId: input.instrumentId,
          participationId: input.participationId,
          windows,
          activeFrom,
          ...(revived ? { state: 'PENDING' as AssignmentState, closedReason: null } : {}),
        },
      },
    )
    .lean()
    .exec();

  if (!updated) throw notFound('No such assignment');
  return toAssignmentView(updated, now);
}

function resolveActiveFrom(given: string | null, windows: WindowsDoc | null, now: Date): Date {
  if (given !== null) {
    const parsed = new Date(given);
    if (Number.isNaN(parsed.getTime())) {
      throw fail('VALIDATION_FAILED', 'activeFrom is not an instant', [
        { path: 'activeFrom', message: 'not a valid date and time' },
      ]);
    }
    return parsed;
  }
  return windows ? windows.assessmentOpens.utc : now;
}

export interface AssignmentPage {
  rows: AssignmentView[];
  nextCursor: string | null;
}

export async function listAssignments(query: AssignmentQuery, now: Date): Promise<AssignmentPage> {
  const filter: TenantFilter<AssignmentDoc> = {};
  if (query.cycleId) filter.cycleId = query.cycleId;
  if (query.acoOrgId) filter.acoOrgId = query.acoOrgId;
  if (query.participationId) filter.participationId = query.participationId;
  if (query.assessorKind) filter.assessorKind = query.assessorKind;
  if (query.state) filter.state = query.state;
  // ids are ULIDs, so the last id of a page is also its high-water mark
  if (query.cursor) filter._id = { $gt: query.cursor };

  const rows = await assignments
    .find(filter)
    .sort({ _id: 1 })
    .limit(query.limit + 1)
    .lean()
    .exec();

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((row) => toAssignmentView(row, now)),
    nextCursor: rows.length > query.limit && last ? last._id : null,
  };
}

export async function loadAssignment(assignmentId: string): Promise<AssignmentDoc> {
  const doc = await assignments.findById(assignmentId).lean().exec();
  if (!doc) throw notFound('No such assignment');
  return doc;
}

export async function readAssignment(assignmentId: string, now: Date): Promise<AssignmentView> {
  return toAssignmentView(await loadAssignment(assignmentId), now);
}

/**
 * The assessor's own assignment. Someone else's row inside the same
 * organisation is answered as not found rather than as forbidden: an assessor
 * has no business learning which other assignment ids exist.
 */
export async function loadOwnAssignment(assignmentId: string, userId: string): Promise<AssignmentDoc> {
  const doc = await loadAssignment(assignmentId);
  if (doc.assessorUserId !== userId) throw notFound('No such assignment');
  return doc;
}

export async function revokeAssignment(
  assignmentId: string,
  reason: string,
  now: Date,
): Promise<AssignmentView> {
  const existing = await loadAssignment(assignmentId);
  if (existing.state === 'COMPLETED') {
    throw conflict('This assessor has already submitted. A submitted return cannot be withdrawn here.');
  }

  const updated = await assignments
    .findOneAndUpdate(
      { _id: assignmentId, state: { $ne: 'COMPLETED' } },
      { $set: { state: 'REVOKED', closedReason: reason, currentAssessmentId: null } },
    )
    .lean()
    .exec();
  if (!updated) throw conflict('This assignment changed while it was being withdrawn');

  await discardOpenDraft(assignmentId);
  return toAssignmentView(updated, now);
}

export async function declineAssignment(
  assignmentId: string,
  userId: string,
  reason: string,
  now: Date,
): Promise<AssignmentView> {
  const existing = await loadOwnAssignment(assignmentId, userId);
  if (existing.state === 'COMPLETED') {
    throw conflict('You have already submitted this assessment');
  }

  const updated = await assignments
    .findOneAndUpdate(
      { _id: assignmentId, state: { $ne: 'COMPLETED' } },
      { $set: { state: 'DECLINED', closedReason: reason, currentAssessmentId: null } },
    )
    .lean()
    .exec();
  if (!updated) throw conflict('This assignment changed while it was being declined');

  await discardOpenDraft(assignmentId);
  return toAssignmentView(updated, now);
}

/**
 * A draft left behind by a withdrawn or declined assignment is discarded rather
 * than deleted, because the fact that somebody started answering is itself worth
 * keeping. openDraftKey is cleared so the slot is free if the assignment revives.
 */
async function discardOpenDraft(assignmentId: string): Promise<void> {
  await assessments.updateOne(
    { assignmentId, state: 'DRAFT' },
    { $set: { state: 'DISCARDED', openDraftKey: null } },
  );
}

export interface WorklistRow extends AssignmentView {
  /** What the assessor can do right now, so the list does not have to guess. */
  action: 'START' | 'CONTINUE' | 'VIEW' | 'WAIT' | 'NONE';
}

function actionFor(assignment: AssignmentDoc, state: WindowState): WorklistRow['action'] {
  if (assignment.state === 'REVOKED' || assignment.state === 'DECLINED') return 'NONE';
  if (assignment.state === 'COMPLETED') {
    // a self assessment may be taken again at any time, so it is never finished
    return assignment.assessorKind === 'SELF' ? 'START' : 'VIEW';
  }
  if (state === 'NOT_YET_OPEN') return 'WAIT';
  if (state === 'CLOSED') return 'NONE';
  return assignment.currentAssessmentId === null ? 'START' : 'CONTINUE';
}

/**
 * Everything this assessor has been asked to do, across every terminal in the
 * organisation they are acting in, most urgent first. A person who assesses
 * terminals in more than one organisation has one worklist per organisation:
 * the alternative is a query that spans tenants, which the kernel only permits
 * with a recorded reason and which would be reading somebody else's data to
 * build somebody's to-do list.
 */
export async function worklist(userId: string, query: WorklistQuery, now: Date): Promise<WorklistRow[]> {
  const filter: TenantFilter<AssignmentDoc> = { assessorUserId: userId };
  if (query.cycleId) filter.cycleId = query.cycleId;
  if (query.acoOrgId) filter.acoOrgId = query.acoOrgId;
  if (!query.includeFinished) filter.state = { $nin: ['REVOKED', 'DECLINED'] };

  const rows = await assignments.find(filter).lean().exec();

  return rows
    .map((row) => {
      const state = windowStateOf(row, now);
      return { ...toAssignmentView(row, now), action: actionFor(row, state) };
    })
    .sort(byUrgency);
}

function byUrgency(a: WorklistRow, b: WorklistRow): number {
  const closes = (row: WorklistRow): number =>
    row.window ? new Date(row.window.closesAt).getTime() : Number.MAX_SAFE_INTEGER;
  return closes(a) - closes(b) || a.activeFrom.localeCompare(b.activeFrom) || a.id.localeCompare(b.id);
}

export interface KindCompletion {
  assigned: number;
  pending: number;
  inProgress: number;
  completed: number;
  declined: number;
  revoked: number;
  submissions: number;
}

export interface CompletionView {
  cycleId: string;
  acoOrgId: string;
  participationId: string | null;
  byKind: Record<AssessorKind, KindCompletion>;
  totals: KindCompletion;
  /** True once the operator has graded itself at least once in this cycle. */
  selfComplete: boolean;
  /** Distinct customer returns submitted, which is what feeds the score. */
  customerSubmissions: number;
  externalSubmissions: number;
}

const STATE_FIELD: Readonly<Record<AssignmentState, keyof KindCompletion>> = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'inProgress',
  COMPLETED: 'completed',
  DECLINED: 'declined',
  REVOKED: 'revoked',
});

function emptyCompletion(): KindCompletion {
  return { assigned: 0, pending: 0, inProgress: 0, completed: 0, declined: 0, revoked: 0, submissions: 0 };
}

/**
 * The terminal's completion state for one cycle: who was asked, who answered,
 * and how many returns actually landed. Counted in the database rather than by
 * reading every assignment back, because this is the tile a cycle dashboard
 * draws once per terminal.
 */
export async function completionFor(
  cycleId: string,
  acoOrgId: string,
  participationId: string | null,
): Promise<CompletionView> {
  const match: Record<string, unknown> = { cycleId, acoOrgId };
  if (participationId !== null) match['participationId'] = participationId;

  const rows = await assignments
    .aggregate<{ _id: { kind: AssessorKind; state: AssignmentState }; count: number; submissions: number }>([
      { $match: match },
      {
        $group: {
          _id: { kind: '$assessorKind', state: '$state' },
          count: { $sum: 1 },
          submissions: { $sum: '$submissionCount' },
        },
      },
    ])
    .exec();

  const byKind = Object.fromEntries(
    AssessorKind.options.map((kind) => [kind, emptyCompletion()]),
  ) as Record<AssessorKind, KindCompletion>;
  const totals = emptyCompletion();

  for (const row of rows) {
    const bucket = byKind[row._id.kind];
    const field = STATE_FIELD[row._id.state];
    bucket.assigned += row.count;
    bucket[field] += row.count;
    bucket.submissions += row.submissions;
    totals.assigned += row.count;
    totals[field] += row.count;
    totals.submissions += row.submissions;
  }

  return {
    cycleId,
    acoOrgId,
    participationId,
    byKind,
    totals,
    selfComplete: byKind.SELF.submissions > 0,
    customerSubmissions: byKind.CUSTOMER.submissions,
    externalSubmissions: byKind.EXTERNAL.submissions,
  };
}

/** Kept in step by the runtime after every save, so the worklist needs no join. */
export async function recordProgress(
  assignmentId: string,
  assessmentId: string,
  completeness: CompletenessDoc,
  now: Date,
): Promise<void> {
  await assignments.updateOne(
    { _id: assignmentId, state: { $nin: ['REVOKED', 'DECLINED'] } },
    {
      $set: {
        completeness,
        currentAssessmentId: assessmentId,
        state: 'IN_PROGRESS',
        startedAt: now,
      },
    },
  );
}

/**
 * Submission is recorded on the assignment after the return itself has been
 * closed. The two writes are not one transaction, so submit is idempotent and a
 * repeat call re-runs this: a failure here leaves a submitted return and a stale
 * assignment, and the repair is the assessor pressing submit again.
 */
export async function recordSubmission(
  assignmentId: string,
  assessmentId: string,
  completeness: CompletenessDoc,
  submittedAt: Date,
  submissionCount: number,
): Promise<void> {
  await assignments.updateOne(
    { _id: assignmentId },
    {
      $set: {
        state: 'COMPLETED',
        completeness,
        currentAssessmentId: assessmentId,
        submittedAt,
        submissionCount,
      },
    },
  );
}

export async function countSubmissions(assignmentId: string): Promise<number> {
  return assessments.countDocuments({ assignmentId, state: 'SUBMITTED' });
}
