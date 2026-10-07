/**
 * The cycle status machine (ARCHITECTURE.md §5 `cycles.status`, §6
 * `POST /cycles/:id/publish` and `/transition`, §7 "Cycle clock").
 *
 * Guard table — every edge the machine allows and who may take it:
 *
 *   from               to                 via             when
 *   DRAFT              PUBLISHED          PUBLISH         publish before sampling.start
 *   DRAFT              SAMPLING_OPEN      PUBLISH         publish once sampling.start has passed
 *   PUBLISHED          SAMPLING_OPEN      AUTO, MANUAL    clock: sampling.start · manual: open early
 *   SAMPLING_OPEN      SAMPLING_CLOSED    AUTO, MANUAL    clock: sampling.end · manual: close early
 *   SAMPLING_CLOSED    SAMPLING_OPEN      MANUAL          ACFI re-opens (after extending sampling.end)
 *   SAMPLING_CLOSED    ASSESSMENT_OPEN    AUTO, MANUAL    clock: assessment.start · manual: activate early
 *   ASSESSMENT_OPEN    ASSESSMENT_CLOSED  AUTO, MANUAL    clock: assessment.end · manual: close early
 *   ASSESSMENT_CLOSED  ASSESSMENT_OPEN    MANUAL          ACFI re-opens (after extending assessment.end)
 *   ASSESSMENT_CLOSED  SCORED             AUTO, MANUAL    the scoring run completed
 *   SCORED             ARCHIVED           MANUAL          housekeeping
 *
 * Everything else is refused. DRAFT leaves only through publish; ARCHIVED is
 * terminal. A re-open into a window whose end has already passed is refused
 * by `checkManualTransition`, because the clock would close it again on the
 * next tick.
 */
import type { CycleStatus, InstantLike } from './types.js';
import { instantOf } from './types.js';

export type TransitionVia = 'AUTO' | 'MANUAL' | 'PUBLISH';

export interface TransitionRule {
  from: CycleStatus;
  to: CycleStatus;
  via: readonly TransitionVia[];
}

export const TRANSITION_TABLE: readonly TransitionRule[] = [
  { from: 'DRAFT', to: 'PUBLISHED', via: ['PUBLISH'] },
  { from: 'DRAFT', to: 'SAMPLING_OPEN', via: ['PUBLISH'] },
  { from: 'PUBLISHED', to: 'SAMPLING_OPEN', via: ['AUTO', 'MANUAL'] },
  { from: 'SAMPLING_OPEN', to: 'SAMPLING_CLOSED', via: ['AUTO', 'MANUAL'] },
  { from: 'SAMPLING_CLOSED', to: 'SAMPLING_OPEN', via: ['MANUAL'] },
  { from: 'SAMPLING_CLOSED', to: 'ASSESSMENT_OPEN', via: ['AUTO', 'MANUAL'] },
  { from: 'ASSESSMENT_OPEN', to: 'ASSESSMENT_CLOSED', via: ['AUTO', 'MANUAL'] },
  { from: 'ASSESSMENT_CLOSED', to: 'ASSESSMENT_OPEN', via: ['MANUAL'] },
  { from: 'ASSESSMENT_CLOSED', to: 'SCORED', via: ['AUTO', 'MANUAL'] },
  { from: 'SCORED', to: 'ARCHIVED', via: ['MANUAL'] },
];

/** Every status that may follow `status`, by any route. */
export function allowedTransitions(status: CycleStatus): CycleStatus[] {
  return TRANSITION_TABLE.filter((rule) => rule.from === status).map((rule) => rule.to);
}

function rule(from: CycleStatus, to: CycleStatus): TransitionRule | undefined {
  return TRANSITION_TABLE.find((candidate) => candidate.from === from && candidate.to === to);
}

/** May an operator with `cycles.operate` move the cycle from `from` to `to`? */
export function canManuallyTransition(from: CycleStatus, to: CycleStatus): boolean {
  return rule(from, to)?.via.includes('MANUAL') ?? false;
}

export function isTerminalStatus(status: CycleStatus): boolean {
  return allowedTransitions(status).length === 0;
}

/** The minimal cycle shape the clock needs. */
export interface CycleClock {
  status: CycleStatus;
  sampling: { start: InstantLike; end: InstantLike };
  assessment: { start: InstantLike; end: InstantLike };
}

export type TransitionTrigger = 'SAMPLING_START' | 'SAMPLING_END' | 'ASSESSMENT_START' | 'ASSESSMENT_END' | 'SCORING';

export interface DueTransition {
  from: CycleStatus;
  to: CycleStatus;
  trigger: TransitionTrigger;
  /** The window instant that made it due (for the idempotency slot and the audit entry). */
  at: Date;
}

/** Status the cycle lands on when published at `now` (§6: SAMPLING_OPEN if sampling already started). */
export function statusAfterPublish(cycle: Pick<CycleClock, 'sampling'>, now: Date): 'PUBLISHED' | 'SAMPLING_OPEN' {
  return now.getTime() >= instantOf(cycle.sampling.start).getTime() ? 'SAMPLING_OPEN' : 'PUBLISHED';
}

/**
 * The single automatic step the scheduler should perform at `now`, or null.
 * One step per call: a cycle whose windows were all missed advances one
 * status per call (use `dueTransitions` to see the whole catch-up chain).
 *
 * ASSESSMENT_CLOSED → SCORED is reported with trigger `SCORING`: it is due
 * as soon as the assessment is closed, and the scheduler performs it by
 * running scoring, not by merely flipping the status.
 */
export function dueTransition(cycle: CycleClock, now: Date): DueTransition | null {
  const t = now.getTime();
  const reached = (edge: InstantLike): boolean => t >= instantOf(edge).getTime();
  switch (cycle.status) {
    case 'PUBLISHED':
      return reached(cycle.sampling.start)
        ? { from: 'PUBLISHED', to: 'SAMPLING_OPEN', trigger: 'SAMPLING_START', at: instantOf(cycle.sampling.start) }
        : null;
    case 'SAMPLING_OPEN':
      return reached(cycle.sampling.end)
        ? { from: 'SAMPLING_OPEN', to: 'SAMPLING_CLOSED', trigger: 'SAMPLING_END', at: instantOf(cycle.sampling.end) }
        : null;
    case 'SAMPLING_CLOSED':
      return reached(cycle.assessment.start)
        ? {
            from: 'SAMPLING_CLOSED',
            to: 'ASSESSMENT_OPEN',
            trigger: 'ASSESSMENT_START',
            at: instantOf(cycle.assessment.start),
          }
        : null;
    case 'ASSESSMENT_OPEN':
      return reached(cycle.assessment.end)
        ? {
            from: 'ASSESSMENT_OPEN',
            to: 'ASSESSMENT_CLOSED',
            trigger: 'ASSESSMENT_END',
            at: instantOf(cycle.assessment.end),
          }
        : null;
    case 'ASSESSMENT_CLOSED':
      return { from: 'ASSESSMENT_CLOSED', to: 'SCORED', trigger: 'SCORING', at: instantOf(cycle.assessment.end) };
    case 'DRAFT':
    case 'SCORED':
    case 'ARCHIVED':
      return null;
  }
}

/** The full chain of automatic steps due at `now`, in order (empty when nothing is due). */
export function dueTransitions(cycle: CycleClock, now: Date): DueTransition[] {
  const chain: DueTransition[] = [];
  let status = cycle.status;
  for (;;) {
    const step = dueTransition({ ...cycle, status }, now);
    if (step === null) return chain;
    chain.push(step);
    status = step.to;
  }
}

export type ManualTransitionProblemCode = 'NOT_ALLOWED' | 'WINDOW_ALREADY_ENDED';

export interface ManualTransitionProblem {
  code: ManualTransitionProblemCode;
  message: string;
}

export interface ManualTransitionCheck {
  ok: boolean;
  problems: ManualTransitionProblem[];
}

/**
 * Full guard for `POST /cycles/:id/transition`: the edge must be manual, and a
 * re-open must target a window that is still open on the clock.
 */
export function checkManualTransition(cycle: CycleClock, to: CycleStatus, now: Date): ManualTransitionCheck {
  const problems: ManualTransitionProblem[] = [];
  if (!canManuallyTransition(cycle.status, to)) {
    problems.push({ code: 'NOT_ALLOWED', message: `Cannot move a ${cycle.status} cycle to ${to}` });
    return { ok: false, problems };
  }
  const reopensInto: Partial<Record<CycleStatus, InstantLike>> = {
    SAMPLING_OPEN: cycle.sampling.end,
    ASSESSMENT_OPEN: cycle.assessment.end,
  };
  const isReopen =
    (cycle.status === 'SAMPLING_CLOSED' && to === 'SAMPLING_OPEN') ||
    (cycle.status === 'ASSESSMENT_CLOSED' && to === 'ASSESSMENT_OPEN');
  const windowEnd = reopensInto[to];
  if (isReopen && windowEnd !== undefined && now.getTime() >= instantOf(windowEnd).getTime()) {
    problems.push({
      code: 'WINDOW_ALREADY_ENDED',
      message: `Extend the window end before re-opening; it ended at ${instantOf(windowEnd).toISOString()}`,
    });
  }
  return { ok: problems.length === 0, problems };
}
