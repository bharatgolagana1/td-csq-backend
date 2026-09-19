import { isOpen, type CycleWindows } from '@csq/core';
import type { CycleState } from './cycles.contracts.js';
import type { WindowBoundaryName } from './cycles.contracts.js';

/**
 * The cycle state machine, as data.
 *
 * Every legal edge, who may trigger it, the clock condition that must hold, and
 * what stops being editable once it has been taken. Keeping it as a table rather
 * than a chain of if statements means the set of legal transitions is
 * enumerable, testable without a database, and impossible to extend by accident
 * in a handler.
 *
 * Note what has no edge at all: there is no transition that opens a window
 * early. OPEN_SAMPLING and OPEN_ASSESSMENT are gated on the resolved instant, so
 * the manual endpoint and the scheduled task apply exactly the same rule and
 * neither an impatient operator nor a mis-set server clock can bring a cycle
 * forward. Invitations that have gone out cannot be recalled, so that edge is
 * one the product does not get to have.
 */

export const CYCLES_READ = 'cycles:read';
export const CYCLES_WRITE = 'cycles:write';
export const CYCLES_SCHEDULE = 'cycles:schedule';
export const CYCLES_OPERATE = 'cycles:operate';
export const CYCLES_SCORE = 'cycles:score';
export const CYCLES_PUBLISH = 'cycles:publish';
export const CYCLES_PARTICIPATIONS_WRITE = 'cycles.participations:write';

export const CYCLE_TRANSITIONS = [
  'SCHEDULE',
  'UNSCHEDULE',
  'OPEN_SAMPLING',
  'OPEN_ASSESSMENT',
  'CLOSE',
  'SCORE',
  'PUBLISH',
] as const;
export type CycleTransition = (typeof CYCLE_TRANSITIONS)[number];

export const FREEZE_FIELDS = [
  'configurationFrozenAt',
  'rosterRemovalFrozenAt',
  'instrumentFrozenAt',
  'submissionsFrozenAt',
  'scoresFrozenAt',
  'publishedAt',
] as const;
export type FreezeField = (typeof FREEZE_FIELDS)[number];

export type ClockGate =
  | { readonly kind: 'NONE' }
  /** The boundary must already have passed. */
  | { readonly kind: 'AFTER'; readonly boundary: WindowBoundaryName }
  /** The boundary must still be in the future. */
  | { readonly kind: 'BEFORE'; readonly boundary: WindowBoundaryName };

export interface TransitionSpec {
  readonly name: CycleTransition;
  readonly from: CycleState;
  readonly to: CycleState;
  readonly capability: string;
  readonly clock: ClockGate;
  /** Stamped when this edge is taken. */
  readonly freeze: FreezeField | null;
  /** Cleared when this edge is taken. Only a reversal clears anything. */
  readonly clears: readonly FreezeField[];
  /** True when the scheduled-task driver takes this edge with no person involved. */
  readonly automatic: boolean;
  /** What stops being editable. Shown to the operator, so it is written for them. */
  readonly freezes: string;
}

export const TRANSITIONS: readonly TransitionSpec[] = Object.freeze([
  {
    name: 'SCHEDULE',
    from: 'DRAFT',
    to: 'SCHEDULED',
    capability: CYCLES_SCHEDULE,
    // a cycle whose sampling window has already started cannot be scheduled: it
    // would open the instant it was saved, with no chance to check the dates
    clock: { kind: 'BEFORE', boundary: 'samplingOpens' },
    freeze: 'configurationFrozenAt',
    clears: [],
    automatic: false,
    freezes: 'Windows, minimum sampling size and the form scope. Unschedule to change them.',
  },
  {
    name: 'UNSCHEDULE',
    from: 'SCHEDULED',
    to: 'DRAFT',
    capability: CYCLES_SCHEDULE,
    clock: { kind: 'BEFORE', boundary: 'samplingOpens' },
    freeze: null,
    clears: ['configurationFrozenAt'],
    automatic: false,
    freezes: 'Nothing. Pending reminders and window tasks are withdrawn.',
  },
  {
    name: 'OPEN_SAMPLING',
    from: 'SCHEDULED',
    to: 'SAMPLING_OPEN',
    capability: CYCLES_OPERATE,
    clock: { kind: 'AFTER', boundary: 'samplingOpens' },
    freeze: 'rosterRemovalFrozenAt',
    clears: [],
    automatic: true,
    freezes: 'The roster. An operator can no longer be removed, only withdrawn.',
  },
  {
    name: 'OPEN_ASSESSMENT',
    from: 'SAMPLING_OPEN',
    to: 'ASSESSMENT_OPEN',
    capability: CYCLES_OPERATE,
    clock: { kind: 'AFTER', boundary: 'assessmentOpens' },
    freeze: 'instrumentFrozenAt',
    clears: [],
    automatic: true,
    // the state changes, the sampling window does not: whether sampling is still
    // open is answered by the window predicate, never by this label
    freezes: 'The instrument. Sampling may still be open; the window decides that, not this state.',
  },
  {
    name: 'CLOSE',
    from: 'ASSESSMENT_OPEN',
    to: 'CLOSED',
    capability: CYCLES_OPERATE,
    clock: { kind: 'AFTER', boundary: 'assessmentCloses' },
    freeze: 'submissionsFrozenAt',
    clears: [],
    automatic: true,
    freezes: 'Submissions. Nothing further can be answered or changed.',
  },
  {
    name: 'SCORE',
    from: 'CLOSED',
    to: 'SCORED',
    capability: CYCLES_SCORE,
    clock: { kind: 'NONE' },
    freeze: 'scoresFrozenAt',
    clears: [],
    automatic: false,
    freezes: 'The scoring inputs and the weighting profile that produced the result.',
  },
  {
    name: 'PUBLISH',
    from: 'SCORED',
    to: 'PUBLISHED',
    capability: CYCLES_PUBLISH,
    clock: { kind: 'NONE' },
    freeze: 'publishedAt',
    clears: [],
    automatic: false,
    freezes: 'Everything. A published cycle is the public record and is terminal.',
  },
]);

const BY_NAME: ReadonlyMap<CycleTransition, TransitionSpec> = new Map(
  TRANSITIONS.map((t) => [t.name, t]),
);

export function transitionSpec(name: CycleTransition): TransitionSpec {
  const spec = BY_NAME.get(name);
  if (!spec) throw new Error(`Unknown transition ${name}`);
  return spec;
}

export function legalTransitionsFrom(state: CycleState): readonly TransitionSpec[] {
  return TRANSITIONS.filter((t) => t.from === state);
}

export function isTerminal(state: CycleState): boolean {
  return legalTransitionsFrom(state).length === 0;
}

export function boundaryOf(windows: CycleWindows, name: WindowBoundaryName): Date {
  return windows[name].utc;
}

export function clockSatisfied(gate: ClockGate, windows: CycleWindows, now: Date): boolean {
  switch (gate.kind) {
    case 'NONE':
      return true;
    case 'AFTER':
      return now.getTime() >= boundaryOf(windows, gate.boundary).getTime();
    case 'BEFORE':
      return now.getTime() < boundaryOf(windows, gate.boundary).getTime();
  }
}

export function explainClock(gate: ClockGate, windows: CycleWindows): string {
  switch (gate.kind) {
    case 'NONE':
      return 'No clock condition.';
    case 'AFTER':
      return `${gate.boundary} has not arrived yet. It is ${boundaryOf(windows, gate.boundary).toISOString()}.`;
    case 'BEFORE':
      return `${gate.boundary} has already passed. It was ${boundaryOf(windows, gate.boundary).toISOString()}.`;
  }
}

/** The clock-driven edge available from this state right now, if any. */
export function nextAutomaticTransition(
  state: CycleState,
  windows: CycleWindows,
  now: Date,
): TransitionSpec | null {
  for (const spec of legalTransitionsFrom(state)) {
    if (!spec.automatic) continue;
    if (clockSatisfied(spec.clock, windows, now)) return spec;
  }
  return null;
}

/**
 * Every clock-driven edge that is already due, in order.
 *
 * An instance that was down over a whole window must catch up rather than sit in
 * a state the clock left behind, so the driver walks the chain instead of taking
 * one step per tick.
 */
export function planCatchUp(
  state: CycleState,
  windows: CycleWindows,
  now: Date,
): readonly TransitionSpec[] {
  const plan: TransitionSpec[] = [];
  let current = state;
  // the machine is acyclic on automatic edges, so the state count is a hard bound
  for (let guard = 0; guard < TRANSITIONS.length; guard += 1) {
    const next = nextAutomaticTransition(current, windows, now);
    if (!next) break;
    plan.push(next);
    current = next.to;
  }
  return plan;
}

/** The next clock-driven edge and the instant it becomes due, whether or not it is due yet. */
export function nextScheduledEdge(
  state: CycleState,
  windows: CycleWindows,
): { readonly name: CycleTransition; readonly at: Date } | null {
  for (const spec of legalTransitionsFrom(state)) {
    if (!spec.automatic || spec.clock.kind !== 'AFTER') continue;
    return { name: spec.name, at: boundaryOf(windows, spec.clock.boundary) };
  }
  return null;
}

/**
 * Every instant a clock-driven edge becomes due, for a cycle about to be
 * scheduled. One scheduled task is created per entry.
 */
export function automaticBoundaries(
  state: CycleState,
  windows: CycleWindows,
): ReadonlyArray<{ readonly name: CycleTransition; readonly boundary: WindowBoundaryName; readonly at: Date }> {
  const out: Array<{ name: CycleTransition; boundary: WindowBoundaryName; at: Date }> = [];
  let current = state;
  for (let guard = 0; guard < TRANSITIONS.length; guard += 1) {
    const spec = legalTransitionsFrom(current).find((t) => t.automatic && t.clock.kind === 'AFTER');
    if (!spec || spec.clock.kind !== 'AFTER') break;
    out.push({ name: spec.name, boundary: spec.clock.boundary, at: boundaryOf(windows, spec.clock.boundary) });
    current = spec.to;
  }
  return out;
}

/**
 * Whether work may be done, which is a question about windows and not about the
 * state label. Sampling and assessment are reported independently because they
 * overlap by design: late-added customers being sampled after assessment has
 * begun is a requirement.
 */
export function windowStatus(
  windows: CycleWindows,
  state: CycleState,
  now: Date,
): { readonly samplingOpen: boolean; readonly assessmentOpen: boolean } {
  // a draft has dates but no standing: nothing is open until it is scheduled and
  // the clock has actually taken it there
  const started = state !== 'DRAFT' && state !== 'SCHEDULED';
  const finished = state === 'CLOSED' || state === 'SCORED' || state === 'PUBLISHED';
  if (!started || finished) return { samplingOpen: false, assessmentOpen: false };
  return {
    samplingOpen: isOpen(windows, 'SAMPLING', now),
    assessmentOpen: isOpen(windows, 'ASSESSMENT', now),
  };
}
