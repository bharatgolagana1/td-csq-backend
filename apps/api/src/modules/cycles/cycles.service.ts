import {
  evaluateLockGate,
  explainGate,
  isOpen,
  remindersWithin,
  validateOrdering,
  type CycleWindows,
} from '@csq/core';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { newId } from '../../kernel/ids.js';
import { TenantRepo } from '../../kernel/tenancy.js';
import {
  CycleModel,
  ParticipationModel,
  ProgramModel,
  type CycleDoc,
  type ParticipationDoc,
  type ProgramDoc,
  type ReminderDoc,
  type StoredBoundary,
  type StoredWindows,
} from './cycles.models.js';
import {
  boundaryView,
  resolveBoundary,
} from './cycles.time.js';
import {
  legalTransitionsFrom,
  nextScheduledEdge,
  planCatchUp,
  transitionSpec,
  windowStatus,
  type CycleTransition,
  type TransitionSpec,
} from './cycles.state.js';
import {
  cancelPendingTasks,
  scheduleCycleTasks,
  syncReminderTasks,
} from './cycles.tasks.js';
import type {
  CreateCycle,
  CreateParticipation,
  CreateProgram,
  CycleListQuery,
  CycleState,
  CycleView,
  ParticipationListQuery,
  ParticipationView,
  ProgramView,
  ReminderInput,
  ReminderView,
  UpdateCycle,
  UpdateProgram,
  WindowsInput,
} from './cycles.contracts.js';

/**
 * No function here takes an organisation id. The tenancy plugin reads it from
 * the request scope, so there is no argument for a caller to get wrong.
 *
 * The one deliberate exception is the worker surface in cycles.tasks.ts, which
 * runs with no request at all and therefore has to name the organisation it is
 * acting for. It takes that name from the task row it claimed, never from input.
 */

const programs = new TenantRepo<ProgramDoc>(ProgramModel);
const cycles = new TenantRepo<CycleDoc>(CycleModel);
const participations = new TenantRepo<ParticipationDoc>(ParticipationModel);

const DUPLICATE_KEY = 11000;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY
  );
}

function foldCode(code: string): string {
  return code.trim().toLowerCase();
}

function iso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/** Actor of a transition. Null userId means the scheduled-task driver took it. */
export interface TransitionActor {
  readonly userId: string | null;
  readonly automatic: boolean;
}

export function windowsOf(cycle: { windows: StoredWindows }): CycleWindows {
  return cycle.windows;
}

function resolveWindows(input: WindowsInput): StoredWindows {
  const resolved: StoredWindows = {
    samplingOpens: resolveBoundary(input.samplingOpens),
    samplingCloses: resolveBoundary(input.samplingCloses),
    assessmentOpens: resolveBoundary(input.assessmentOpens),
    assessmentCloses: resolveBoundary(input.assessmentCloses),
  };

  // the orderings that must hold, from the pure predicate rather than a rewrite
  // of it here. It permits the assessment window to open while sampling is still
  // open, which is a requirement: late added customers get sampled mid cycle
  const problems = validateOrdering(resolved);
  if (problems.length > 0) {
    throw fail(
      'VALIDATION_FAILED',
      'The cycle windows are not in a workable order',
      problems.map((p) => ({ path: 'windows', message: p })),
    );
  }
  return resolved;
}

/**
 * Reminder instants must fall strictly inside the assessment window. A reminder
 * before it opens has nothing to remind anyone about, and one after it closes
 * arrives when submitting is already impossible.
 */
function resolveReminders(
  input: readonly ReminderInput[],
  windows: StoredWindows,
  existing: readonly ReminderDoc[] = [],
): ReminderDoc[] {
  // identity is the reminder itself, not a client supplied id: an unchanged
  // entry in a re-submitted set keeps the id it had, so editing one reminder
  // does not cancel and re-enqueue the rest
  const identity = (r: { label: string; audience: string; at: { wall: string; tz: string } }): string =>
    `${r.label.trim()}|${r.audience}|${r.at.wall}|${r.at.tz}`;

  const known = new Map(existing.map((r) => [identity(r), r._id]));

  const resolved = input.map((reminder) => {
    const at = resolveBoundary(reminder.at);
    return {
      _id: known.get(identity({ ...reminder, at })) ?? newId(),
      label: reminder.label.trim(),
      audience: reminder.audience,
      at,
    };
  });

  const seen = new Set<string>();
  for (const reminder of resolved) {
    const key = identity(reminder);
    if (seen.has(key)) {
      throw fail('VALIDATION_FAILED', `${reminder.label} is listed twice at the same instant`, [
        { path: 'reminders', message: 'the same reminder appears more than once' },
      ]);
    }
    seen.add(key);
  }

  const inside = new Set(
    remindersWithin(
      windows,
      resolved.map((r) => r.at.utc),
    ).map((d) => d.getTime()),
  );

  const outside = resolved.filter((r) => !inside.has(r.at.utc.getTime()));
  if (outside.length > 0) {
    throw fail(
      'VALIDATION_FAILED',
      'Every reminder must fall inside the assessment window',
      outside.map((r) => ({
        path: 'reminders',
        message: `${r.label} at ${r.at.wall} ${r.at.tz} is outside ${windows.assessmentOpens.wall} to ${windows.assessmentCloses.wall}`,
      })),
    );
  }
  return resolved;
}

function reminderView(reminder: ReminderDoc): ReminderView {
  return {
    id: reminder._id,
    label: reminder.label,
    audience: reminder.audience,
    at: boundaryView(toBoundary(reminder.at)),
  };
}

function toBoundary(stored: StoredBoundary): StoredBoundary {
  return { wall: stored.wall, tz: stored.tz, utc: new Date(stored.utc) };
}

export function cycleView(cycle: CycleDoc, now: Date, participationCount: number): CycleView {
  const windows = windowsOf(cycle);
  const status = windowStatus(windows, cycle.state, now);
  const next = nextScheduledEdge(cycle.state, windows);

  return {
    id: cycle._id,
    programId: cycle.programId,
    code: cycle.code,
    name: cycle.name,
    state: cycle.state,
    formScope: cycle.formScope,
    minimumSamplingSize: cycle.minimumSamplingSize,
    windows: {
      samplingOpens: boundaryView(toBoundary(cycle.windows.samplingOpens)),
      samplingCloses: boundaryView(toBoundary(cycle.windows.samplingCloses)),
      assessmentOpens: boundaryView(toBoundary(cycle.windows.assessmentOpens)),
      assessmentCloses: boundaryView(toBoundary(cycle.windows.assessmentCloses)),
    },
    reminders: cycle.reminders.map(reminderView),
    samplingOpen: status.samplingOpen,
    assessmentOpen: status.assessmentOpen,
    nextTransition: next ? { name: next.name, at: next.at.toISOString() } : null,
    freezes: {
      configurationFrozenAt: iso(cycle.freezes.configurationFrozenAt),
      rosterRemovalFrozenAt: iso(cycle.freezes.rosterRemovalFrozenAt),
      instrumentFrozenAt: iso(cycle.freezes.instrumentFrozenAt),
      submissionsFrozenAt: iso(cycle.freezes.submissionsFrozenAt),
      scoresFrozenAt: iso(cycle.freezes.scoresFrozenAt),
      publishedAt: iso(cycle.freezes.publishedAt),
    },
    participationCount,
    createdAt: new Date(cycle.createdAt).toISOString(),
    updatedAt: new Date(cycle.updatedAt).toISOString(),
  };
}

export function participationView(doc: ParticipationDoc): ParticipationView {
  return {
    id: doc._id,
    cycleId: doc.cycleId,
    acoOrgId: doc.acoOrgId,
    airportId: doc.airportId,
    formScope: doc.formScope,
    state: doc.state,
    sampling: {
      state: doc.sampling.state,
      minimumSamplingSize: doc.sampling.minimumSamplingSize,
      lockedAt: iso(doc.sampling.lockedAt),
      lockedCount: doc.sampling.lockedCount,
      eligibleCountAtLock: doc.sampling.eligibleCountAtLock,
      shortfall: doc.sampling.shortfall,
    },
    progress: {
      selfSubmittedAt: iso(doc.progress.selfSubmittedAt),
      externalSubmittedAt: iso(doc.progress.externalSubmittedAt),
      customerInvited: doc.progress.customerInvited,
      customerSubmitted: doc.progress.customerSubmitted,
    },
    scoring: {
      state: doc.scoring.state,
      scoredAt: iso(doc.scoring.scoredAt),
      suppression: doc.scoring.suppression,
    },
    invitedAt: new Date(doc.invitedAt).toISOString(),
    withdrawnAt: iso(doc.withdrawnAt),
    withdrawnReason: doc.withdrawnReason,
  };
}

async function requireProgram(programId: string): Promise<ProgramDoc> {
  const found = await programs.findById(programId).lean().exec();
  if (!found) throw notFound('No such programme');
  return found;
}

async function requireCycle(cycleId: string): Promise<CycleDoc> {
  const found = await cycles.findById(cycleId).lean().exec();
  if (!found) throw notFound('No such cycle');
  return found;
}

async function countParticipations(cycleId: string): Promise<number> {
  return participations.countDocuments({ cycleId });
}

export async function createProgram(input: CreateProgram): Promise<ProgramView> {
  // the zone is checked here rather than at the schema, because only the tz
  // database can say whether a zone exists and a regex that guesses is worse
  // than no check at all
  resolveBoundary({ wall: '2000-01-01T00:00', tz: input.defaultTimezone });

  try {
    const created = await programs.create({
      code: input.code.trim(),
      codeKey: foldCode(input.code),
      name: input.name.trim(),
      description: input.description,
      formScope: input.formScope,
      defaultTimezone: input.defaultTimezone,
      defaultMinimumSamplingSize: input.defaultMinimumSamplingSize,
      status: 'ACTIVE',
      archivedAt: null,
    });
    return { ...programViewOf(created.toObject()), cycleCount: 0 };
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict(`${input.code.trim()} is already a programme code`);
    throw error;
  }
}

function programViewOf(doc: ProgramDoc): Omit<ProgramView, 'cycleCount'> {
  return {
    id: doc._id,
    code: doc.code,
    name: doc.name,
    description: doc.description,
    formScope: doc.formScope,
    defaultTimezone: doc.defaultTimezone,
    defaultMinimumSamplingSize: doc.defaultMinimumSamplingSize,
    status: doc.status,
  };
}

export async function listPrograms(): Promise<ProgramView[]> {
  const rows = await programs.find({}).sort({ code: 1 }).lean().exec();
  const counts = await cycleCountsByProgram(rows.map((r) => r._id));
  return rows.map((row) => ({ ...programViewOf(row), cycleCount: counts.get(row._id) ?? 0 }));
}

async function cycleCountsByProgram(programIds: readonly string[]): Promise<Map<string, number>> {
  if (programIds.length === 0) return new Map();
  const rows = await cycles
    .aggregate<{ _id: string; count: number }>([
      { $match: { programId: { $in: [...programIds] } } },
      { $group: { _id: '$programId', count: { $sum: 1 } } },
    ])
    .exec();
  return new Map(rows.map((r) => [r._id, r.count]));
}

export async function readProgram(programId: string): Promise<ProgramView> {
  const program = await requireProgram(programId);
  const counts = await cycleCountsByProgram([program._id]);
  return { ...programViewOf(program), cycleCount: counts.get(program._id) ?? 0 };
}

export async function updateProgram(programId: string, patch: UpdateProgram): Promise<ProgramView> {
  if (patch.defaultTimezone !== undefined) {
    resolveBoundary({ wall: '2000-01-01T00:00', tz: patch.defaultTimezone });
  }

  const assignments: Record<string, unknown> = {};
  if (patch.name !== undefined) assignments['name'] = patch.name.trim();
  if (patch.description !== undefined) assignments['description'] = patch.description;
  if (patch.defaultTimezone !== undefined) assignments['defaultTimezone'] = patch.defaultTimezone;
  if (patch.defaultMinimumSamplingSize !== undefined) {
    assignments['defaultMinimumSamplingSize'] = patch.defaultMinimumSamplingSize;
  }
  if (patch.status !== undefined) {
    assignments['status'] = patch.status;
    assignments['archivedAt'] = patch.status === 'ARCHIVED' ? new Date() : null;
  }

  const updated = await programs
    .findOneAndUpdate({ _id: programId }, { $set: assignments })
    .lean()
    .exec();
  if (!updated) throw notFound('No such programme');

  const counts = await cycleCountsByProgram([updated._id]);
  return { ...programViewOf(updated), cycleCount: counts.get(updated._id) ?? 0 };
}

export async function createCycle(input: CreateCycle, now: Date): Promise<CycleView> {
  const program = await requireProgram(input.programId);
  if (program.status !== 'ACTIVE') {
    throw conflict('That programme is archived, so it cannot take a new cycle');
  }

  const windows = resolveWindows(input.windows);
  const reminders = resolveReminders(input.reminders, windows);

  try {
    const created = await cycles.create({
      programId: program._id,
      code: input.code.trim(),
      codeKey: foldCode(input.code),
      name: input.name.trim(),
      state: 'DRAFT',
      // copied, not referenced: a programme edited later must not silently
      // change the instrument a running cycle is being assessed on
      formScope: program.formScope,
      minimumSamplingSize: input.minimumSamplingSize ?? program.defaultMinimumSamplingSize,
      windows,
      reminders,
      freezes: {
        configurationFrozenAt: null,
        rosterRemovalFrozenAt: null,
        instrumentFrozenAt: null,
        submissionsFrozenAt: null,
        scoresFrozenAt: null,
        publishedAt: null,
      },
      transitions: [],
    });
    return cycleView(created.toObject(), now, 0);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw conflict(`${input.code.trim()} is already a cycle code in this programme`);
    }
    throw error;
  }
}

export async function listCycles(query: CycleListQuery, now: Date): Promise<CycleView[]> {
  const filter: Record<string, unknown> = {};
  if (query.programId !== undefined) filter['programId'] = query.programId;
  if (query.state !== undefined) filter['state'] = query.state;

  const rows = await cycles
    .find(filter)
    .sort({ 'windows.samplingOpens.utc': -1 })
    .limit(query.limit)
    .lean()
    .exec();

  const counts = await participationCountsByCycle(rows.map((r) => r._id));
  return rows.map((row) => cycleView(row, now, counts.get(row._id) ?? 0));
}

async function participationCountsByCycle(cycleIds: readonly string[]): Promise<Map<string, number>> {
  if (cycleIds.length === 0) return new Map();
  const rows = await participations
    .aggregate<{ _id: string; count: number }>([
      { $match: { cycleId: { $in: [...cycleIds] } } },
      { $group: { _id: '$cycleId', count: { $sum: 1 } } },
    ])
    .exec();
  return new Map(rows.map((r) => [r._id, r.count]));
}

export async function readCycle(cycleId: string, now: Date): Promise<CycleView> {
  const cycle = await requireCycle(cycleId);
  return cycleView(cycle, now, await countParticipations(cycleId));
}

/** Configuration edits are refused once SCHEDULE has frozen them. */
function assertConfigurable(cycle: CycleDoc): void {
  if (cycle.freezes.configurationFrozenAt !== null) {
    throw conflict('The configuration froze when this cycle was scheduled. Unschedule it first.');
  }
}

export async function updateCycle(cycleId: string, patch: UpdateCycle, now: Date): Promise<CycleView> {
  const cycle = await requireCycle(cycleId);

  const assignments: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (cycle.state === 'PUBLISHED') throw conflict('A published cycle cannot be renamed');
    assignments['name'] = patch.name.trim();
  }
  if (patch.minimumSamplingSize !== undefined) {
    assertConfigurable(cycle);
    assignments['minimumSamplingSize'] = patch.minimumSamplingSize;
  }

  const updated = await cycles
    .findOneAndUpdate({ _id: cycleId }, { $set: assignments })
    .lean()
    .exec();
  if (!updated) throw notFound('No such cycle');
  return cycleView(updated, now, await countParticipations(cycleId));
}

export async function replaceWindows(
  cycleId: string,
  input: WindowsInput,
  now: Date,
): Promise<CycleView> {
  const cycle = await requireCycle(cycleId);
  assertConfigurable(cycle);

  const windows = resolveWindows(input);
  // moving the windows can put an existing reminder outside them, so the
  // reminders are re-resolved against the new dates rather than left dangling
  const reminders = resolveReminders(
    cycle.reminders.map((r) => ({ label: r.label, audience: r.audience, at: { wall: r.at.wall, tz: r.at.tz } })),
    windows,
    cycle.reminders,
  );

  const updated = await cycles
    .findOneAndUpdate({ _id: cycleId, state: 'DRAFT' }, { $set: { windows, reminders } })
    .lean()
    .exec();
  if (!updated) throw conflict('Only a draft cycle can have its windows changed');
  return cycleView(updated, now, await countParticipations(cycleId));
}

const REMINDERS_EDITABLE_IN: readonly CycleState[] = [
  'DRAFT',
  'SCHEDULED',
  'SAMPLING_OPEN',
  'ASSESSMENT_OPEN',
];

export async function replaceReminders(
  cycleId: string,
  input: readonly ReminderInput[],
  now: Date,
): Promise<CycleView> {
  const cycle = await requireCycle(cycleId);
  if (!REMINDERS_EDITABLE_IN.includes(cycle.state)) {
    throw conflict(`Reminders cannot be changed once a cycle is ${cycle.state}`);
  }

  const reminders = resolveReminders(input, cycle.windows, cycle.reminders);
  if (cycle.state !== 'DRAFT') {
    // a NEW reminder in the past on a live cycle would fire on the next drain,
    // which is an instant unplanned send to everyone outstanding. One that was
    // already on the cycle is left alone: re-submitting the set unchanged must
    // not become impossible just because time has passed
    const kept = new Set(cycle.reminders.map((r) => r._id));
    const past = reminders.filter(
      (r) => !kept.has(r._id) && r.at.utc.getTime() <= now.getTime(),
    );
    if (past.length > 0) {
      throw fail(
        'VALIDATION_FAILED',
        'A reminder on a live cycle must be in the future',
        past.map((r) => ({ path: 'reminders', message: `${r.label} at ${r.at.wall} ${r.at.tz} has passed` })),
      );
    }
  }

  const updated = await cycles
    .findOneAndUpdate({ _id: cycleId, state: cycle.state }, { $set: { reminders } })
    .lean()
    .exec();
  if (!updated) throw conflict('The cycle changed while saving. Reload and try again.');

  if (updated.state !== 'DRAFT') await syncReminderTasks(updated);
  return cycleView(updated, now, await countParticipations(cycleId));
}

export async function deleteCycle(cycleId: string): Promise<void> {
  const cycle = await requireCycle(cycleId);
  if (cycle.state !== 'DRAFT') {
    throw conflict('Only a draft cycle can be deleted. A cycle that has run is the record of it.');
  }
  if ((await countParticipations(cycleId)) > 0) {
    throw conflict('Remove the participating operators before deleting this cycle');
  }
  const { deletedCount } = await cycles.deleteOne({ _id: cycleId, state: 'DRAFT' });
  if (deletedCount === 0) throw conflict('The cycle changed while deleting. Reload and try again.');
}

function assertFrom(cycle: CycleDoc, spec: TransitionSpec): void {
  if (cycle.state === spec.from) return;
  const legal = legalTransitionsFrom(cycle.state)
    .map((t) => t.name)
    .join(', ');
  throw conflict(
    legal.length > 0
      ? `${spec.name} runs from ${spec.from}, and this cycle is ${cycle.state}. Legal here: ${legal}.`
      : `${spec.name} runs from ${spec.from}, and this cycle is ${cycle.state}, which is terminal.`,
  );
}

function assertClock(cycle: CycleDoc, spec: TransitionSpec, now: Date): void {
  const gate = spec.clock;
  if (gate.kind === 'NONE') return;
  const at = cycle.windows[gate.boundary].utc;
  if (gate.kind === 'AFTER') {
    if (now.getTime() >= new Date(at).getTime()) return;
    throw fail(
      'WINDOW_NOT_OPEN',
      `${spec.name} becomes possible at ${new Date(at).toISOString()}, which is ${cycle.windows[gate.boundary].wall} in ${cycle.windows[gate.boundary].tz}`,
    );
  }
  if (now.getTime() < new Date(at).getTime()) return;
  throw fail(
    'WINDOW_CLOSED',
    `${spec.name} is no longer possible: ${gate.boundary} passed at ${new Date(at).toISOString()}`,
  );
}

/**
 * Applies one edge, filtered on the state it expects to be leaving, so two
 * requests racing on the same cycle cannot both take it. Returns null when the
 * filter matched nothing, which means somebody else moved first.
 */
async function applyTransition(
  cycle: CycleDoc,
  spec: TransitionSpec,
  now: Date,
  actor: TransitionActor,
): Promise<CycleDoc | null> {
  const assignments: Record<string, unknown> = { state: spec.to };
  if (spec.freeze !== null) assignments[`freezes.${spec.freeze}`] = now;
  for (const cleared of spec.clears) assignments[`freezes.${cleared}`] = null;

  return cycles
    .findOneAndUpdate(
      { _id: cycle._id, state: spec.from },
      {
        $set: assignments,
        $push: {
          transitions: {
            at: now,
            name: spec.name,
            from: spec.from,
            to: spec.to,
            actorUserId: actor.userId,
            automatic: actor.automatic,
          },
        },
      },
    )
    .lean()
    .exec();
}

async function takeEdge(
  cycleId: string,
  name: CycleTransition,
  now: Date,
  actor: TransitionActor,
): Promise<CycleDoc> {
  const spec = transitionSpec(name);
  const cycle = await requireCycle(cycleId);
  assertFrom(cycle, spec);
  assertClock(cycle, spec, now);

  const updated = await applyTransition(cycle, spec, now, actor);
  if (!updated) throw conflict('The cycle moved while saving. Reload and try again.');
  return updated;
}

export async function scheduleCycle(
  cycleId: string,
  now: Date,
  actor: TransitionActor,
): Promise<CycleView> {
  const cycle = await requireCycle(cycleId);
  const spec = transitionSpec('SCHEDULE');
  assertFrom(cycle, spec);
  assertClock(cycle, spec, now);

  const problems = validateOrdering(windowsOf(cycle));
  if (problems.length > 0) {
    throw fail(
      'VALIDATION_FAILED',
      'The cycle windows are not in a workable order',
      problems.map((p) => ({ path: 'windows', message: p })),
    );
  }

  const stale = cycle.reminders.filter((r) => new Date(r.at.utc).getTime() <= now.getTime());
  if (stale.length > 0) {
    throw fail(
      'VALIDATION_FAILED',
      'Every reminder must still be in the future when a cycle is scheduled',
      stale.map((r) => ({ path: 'reminders', message: `${r.label} at ${r.at.wall} ${r.at.tz} has passed` })),
    );
  }

  const updated = await applyTransition(cycle, spec, now, actor);
  if (!updated) throw conflict('The cycle moved while saving. Reload and try again.');

  // tasks are created after the state moves, so a crash in between leaves a
  // scheduled cycle with no driver rather than a draft with live tasks. The
  // create is idempotent on the dedupe key, so re-running it repairs that
  await scheduleCycleTasks(updated);
  return cycleView(updated, now, await countParticipations(cycleId));
}

export async function unscheduleCycle(
  cycleId: string,
  now: Date,
  actor: TransitionActor,
): Promise<CycleView> {
  const updated = await takeEdge(cycleId, 'UNSCHEDULE', now, actor);
  await cancelPendingTasks(cycleId);
  return cycleView(updated, now, await countParticipations(cycleId));
}

/**
 * Takes every clock-driven edge that is already due.
 *
 * The same function serves the operator endpoint and the scheduled task, which
 * is what guarantees a person cannot open a window the clock has not reached:
 * there is no second code path with looser rules.
 */
export async function advanceCycle(
  cycleId: string,
  now: Date,
  actor: TransitionActor,
): Promise<CycleView> {
  let cycle = await requireCycle(cycleId);
  const plan = planCatchUp(cycle.state, windowsOf(cycle), now);

  if (plan.length === 0) {
    const next = nextScheduledEdge(cycle.state, windowsOf(cycle));
    if (!next) {
      throw conflict(`A ${cycle.state} cycle has no clock driven transition left`);
    }
    throw fail(
      'WINDOW_NOT_OPEN',
      `Nothing is due yet. ${next.name} becomes due at ${next.at.toISOString()}.`,
    );
  }

  for (const spec of plan) {
    const updated = await applyTransition(cycle, spec, now, actor);
    if (updated) {
      cycle = updated;
      continue;
    }
    // somebody else advanced it. Take their result if it is where we were going
    const current = await requireCycle(cycleId);
    if (current.state !== spec.to) {
      throw conflict('The cycle moved while advancing. Reload and try again.');
    }
    cycle = current;
  }

  return cycleView(cycle, now, await countParticipations(cycleId));
}

export async function scoreCycle(
  cycleId: string,
  now: Date,
  actor: TransitionActor,
): Promise<CycleView> {
  const updated = await takeEdge(cycleId, 'SCORE', now, actor);
  return cycleView(updated, now, await countParticipations(cycleId));
}

export async function publishCycle(
  cycleId: string,
  now: Date,
  actor: TransitionActor,
): Promise<CycleView> {
  const updated = await takeEdge(cycleId, 'PUBLISH', now, actor);
  return cycleView(updated, now, await countParticipations(cycleId));
}

const ROSTER_CLOSED_IN: readonly CycleState[] = ['CLOSED', 'SCORED', 'PUBLISHED'];

export async function addParticipation(
  cycleId: string,
  input: CreateParticipation,
  now: Date,
): Promise<ParticipationView> {
  const cycle = await requireCycle(cycleId);
  if (ROSTER_CLOSED_IN.includes(cycle.state)) {
    throw conflict(`A ${cycle.state} cycle cannot take another operator`);
  }
  if (now.getTime() >= new Date(cycle.windows.assessmentCloses.utc).getTime()) {
    throw fail('WINDOW_CLOSED', 'The assessment window has closed, so the roster is closed too');
  }

  try {
    const created = await participations.create({
      cycleId,
      acoOrgId: input.acoOrgId,
      airportId: input.airportId,
      formScope: cycle.formScope,
      state: 'INVITED',
      sampling: {
        state: 'NOT_STARTED',
        // snapshotted: an operator joining late is held to the bar that applied
        // when it joined, not one edited afterwards
        minimumSamplingSize: input.minimumSamplingSize ?? cycle.minimumSamplingSize,
        lockedAt: null,
        lockedCount: null,
        eligibleCountAtLock: null,
        shortfall: null,
      },
      progress: {
        selfSubmittedAt: null,
        externalSubmittedAt: null,
        customerInvited: 0,
        customerSubmitted: 0,
      },
      scoring: { state: 'NOT_SCORED', scoredAt: null, suppression: null },
      invitedAt: now,
      activatedAt: null,
      withdrawnAt: null,
      withdrawnReason: null,
    });
    return participationView(created.toObject());
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict('That operator is already in this cycle');
    throw error;
  }
}

export async function listParticipations(
  cycleId: string,
  query: ParticipationListQuery,
): Promise<ParticipationView[]> {
  await requireCycle(cycleId);
  const filter: Record<string, unknown> = { cycleId };
  if (query.state !== undefined) filter['state'] = query.state;
  if (query.samplingState !== undefined) filter['sampling.state'] = query.samplingState;

  const rows = await participations
    .find(filter)
    .sort({ acoOrgId: 1 })
    .lean()
    .exec();
  return rows.map(participationView);
}

export async function readParticipation(
  cycleId: string,
  participationId: string,
): Promise<ParticipationView> {
  return participationView(await requireParticipation(cycleId, participationId));
}

async function requireParticipation(
  cycleId: string,
  participationId: string,
): Promise<ParticipationDoc> {
  const found = await participations
    .findOne({ _id: participationId, cycleId })
    .lean()
    .exec();
  if (!found) throw notFound('No such participation');
  return found;
}

export async function removeParticipation(cycleId: string, participationId: string): Promise<void> {
  const cycle = await requireCycle(cycleId);
  if (cycle.freezes.rosterRemovalFrozenAt !== null) {
    throw conflict(
      'Sampling has opened, so this operator has been invited. Withdraw it instead of removing it.',
    );
  }
  await requireParticipation(cycleId, participationId);
  const { deletedCount } = await participations.deleteOne({ _id: participationId, cycleId });
  if (deletedCount === 0) throw notFound('No such participation');
}

export async function withdrawParticipation(
  cycleId: string,
  participationId: string,
  reason: string,
  now: Date,
): Promise<ParticipationView> {
  const cycle = await requireCycle(cycleId);
  if (cycle.state === 'SCORED' || cycle.state === 'PUBLISHED') {
    throw conflict('This cycle is already scored, so its roster is part of the result');
  }

  const updated = await participations
    .findOneAndUpdate(
      { _id: participationId, cycleId, state: { $ne: 'WITHDRAWN' } },
      { $set: { state: 'WITHDRAWN', withdrawnAt: now, withdrawnReason: reason.trim() } },
    )
    .lean()
    .exec();

  if (!updated) {
    const existing = await participations
      .findOne({ _id: participationId, cycleId })
      .lean()
      .exec();
    if (existing) throw conflict('That operator has already withdrawn');
    throw notFound('No such participation');
  }
  return participationView(updated);
}

/**
 * Called by the sampling module when an operator locks its batch.
 *
 * The gate itself is the pure function in @csq/core, so the rule that an
 * operator with fewer customers than the minimum must lock all of them lives in
 * one place and is exhaustively tested without a database.
 */
export async function recordSamplingLock(args: {
  cycleId: string;
  participationId: string;
  eligibleCount: number;
  selectedCount: number;
  now: Date;
}): Promise<ParticipationView> {
  const { cycleId, participationId, eligibleCount, selectedCount, now } = args;
  const cycle = await requireCycle(cycleId);
  const participation = await requireParticipation(cycleId, participationId);

  if (participation.state === 'WITHDRAWN') {
    throw conflict('That operator has withdrawn from this cycle');
  }
  if (participation.sampling.state === 'LOCKED') {
    throw fail('BATCH_ALREADY_LOCKED', 'This sample is already locked');
  }

  const windows = windowsOf(cycle);
  if (!isOpen(windows, 'SAMPLING', now)) {
    const opens = new Date(windows.samplingOpens.utc).getTime();
    throw now.getTime() < opens
      ? fail('WINDOW_NOT_OPEN', `Sampling opens at ${new Date(opens).toISOString()}`)
      : fail('WINDOW_CLOSED', `Sampling closed at ${new Date(windows.samplingCloses.utc).toISOString()}`);
  }

  const minimum = participation.sampling.minimumSamplingSize;
  const outcome = evaluateLockGate({ eligibleCount, selectedCount, minimumSamplingSize: minimum });
  if (!outcome.ok) {
    throw fail('SAMPLING_BELOW_MINIMUM', explainGate(outcome, minimum));
  }

  const updated = await participations
    .findOneAndUpdate(
      { _id: participationId, cycleId, 'sampling.state': { $ne: 'LOCKED' } },
      {
        $set: {
          state: 'ACTIVE',
          activatedAt: participation.activatedAt ?? now,
          'sampling.state': 'LOCKED',
          'sampling.lockedAt': now,
          'sampling.lockedCount': selectedCount,
          'sampling.eligibleCountAtLock': eligibleCount,
          'sampling.shortfall': outcome.mustSelectAll ? outcome.shortfall : 0,
        },
      },
    )
    .lean()
    .exec();
  if (!updated) throw fail('BATCH_ALREADY_LOCKED', 'This sample was locked while you were working');
  return participationView(updated);
}

export interface ParticipationProgress {
  readonly selfSubmittedAt?: Date;
  readonly externalSubmittedAt?: Date;
  readonly customerInvited?: number;
  readonly customerSubmitted?: number;
  readonly samplingState?: 'IN_PROGRESS' | 'WAIVED';
}

/** Called by the assessment and sampling modules as an operator makes progress. */
export async function recordParticipationProgress(
  cycleId: string,
  participationId: string,
  progress: ParticipationProgress,
  now: Date,
): Promise<ParticipationView> {
  const existing = await requireParticipation(cycleId, participationId);
  if (existing.state === 'WITHDRAWN') {
    throw conflict('That operator has withdrawn from this cycle');
  }

  // the first recorded progress is what turns an invitation into participation
  const assignments: Record<string, unknown> = {
    state: 'ACTIVE',
    ...(existing.activatedAt === null ? { activatedAt: now } : {}),
  };
  if (progress.selfSubmittedAt !== undefined) {
    assignments['progress.selfSubmittedAt'] = progress.selfSubmittedAt;
  }
  if (progress.externalSubmittedAt !== undefined) {
    assignments['progress.externalSubmittedAt'] = progress.externalSubmittedAt;
  }
  if (progress.customerInvited !== undefined) {
    assignments['progress.customerInvited'] = progress.customerInvited;
  }
  if (progress.customerSubmitted !== undefined) {
    assignments['progress.customerSubmitted'] = progress.customerSubmitted;
  }
  if (progress.samplingState !== undefined) assignments['sampling.state'] = progress.samplingState;

  const updated = await participations
    .findOneAndUpdate({ _id: participationId, cycleId, state: { $ne: 'WITHDRAWN' } }, { $set: assignments })
    .lean()
    .exec();
  if (!updated) throw conflict('That operator withdrew while this was being recorded');
  return participationView(updated);
}

/** Called by the scoring module once a participation has a result or a suppression. */
export async function recordParticipationScore(args: {
  cycleId: string;
  participationId: string;
  state: 'SCORED' | 'SUPPRESSED';
  suppression: string | null;
  now: Date;
}): Promise<ParticipationView> {
  const updated = await participations
    .findOneAndUpdate(
      { _id: args.participationId, cycleId: args.cycleId },
      {
        $set: {
          'scoring.state': args.state,
          'scoring.scoredAt': args.now,
          'scoring.suppression': args.suppression,
        },
      },
    )
    .lean()
    .exec();
  if (!updated) throw notFound('No such participation');
  return participationView(updated);
}
