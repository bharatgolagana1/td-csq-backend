/**
 * May the participant lock its sample? (REQUIREMENTS §13–14; ARCHITECTURE.md
 * §6 `GET /sampling/cycles/:cycleId`, `POST …/lock`; §7 "Sampling": lock
 * refused below the minimum unless eligible < required and everything
 * eligible is selected.)
 */

export type LockBlockReason = 'BELOW_MINIMUM' | 'SELECT_ALL_REQUIRED' | 'NOTHING_SELECTED';
export type ShortfallRule = 'SELECT_ALL';

export interface LockGateInput {
  /** `cycle_participants.requiredSampleSize`. */
  required: number;
  /** Entries currently SELECTED. */
  selectedCount: number;
  /** Entries the operator could select at all (see `eligibleCustomers`). */
  eligibleCount: number;
}

export interface LockEvaluation extends LockGateInput {
  lockable: boolean;
  reason: LockBlockReason | null;
  /** `SELECT_ALL` when the operator cannot reach the minimum and must select everyone. */
  shortfallRule: ShortfallRule | null;
  /** Entries still to select before locking is possible. */
  remaining: number;
  /** The target the operator must reach: `required`, or `eligibleCount` under SELECT_ALL. */
  target: number;
  /** "37 / 50" for the counter. */
  progress: string;
  /** 0..100, rounded to a whole number. */
  progressPct: number;
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${label} must be a whole number ≥ 0 (got ${value})`);
}

/** "37 / 50" */
export function formatProgress(selectedCount: number, target: number): string {
  return `${selectedCount} / ${target}`;
}

export function progressPercent(selectedCount: number, target: number): number {
  if (target <= 0) return 100;
  return Math.min(100, Math.round((selectedCount / target) * 100));
}

/**
 * Rules, in order:
 * 1. Nothing selected → never lockable (an empty lock would invite nobody).
 * 2. selected ≥ required → lockable.
 * 3. eligible < required (shortfall) → lockable only when every eligible entry is selected.
 * 4. Otherwise → BELOW_MINIMUM.
 */
export function evaluateLock(input: LockGateInput): LockEvaluation {
  const { required, selectedCount, eligibleCount } = input;
  assertCount(required, 'required');
  assertCount(selectedCount, 'selectedCount');
  assertCount(eligibleCount, 'eligibleCount');

  const shortfallRule: ShortfallRule | null = eligibleCount < required ? 'SELECT_ALL' : null;
  const target = shortfallRule === 'SELECT_ALL' ? eligibleCount : required;
  const remaining = Math.max(0, target - selectedCount);

  let reason: LockBlockReason | null = null;
  if (selectedCount === 0) reason = 'NOTHING_SELECTED';
  else if (selectedCount >= required) reason = null;
  else if (shortfallRule === 'SELECT_ALL') reason = selectedCount >= eligibleCount ? null : 'SELECT_ALL_REQUIRED';
  else reason = 'BELOW_MINIMUM';

  return {
    required,
    selectedCount,
    eligibleCount,
    lockable: reason === null,
    reason,
    shortfallRule,
    remaining,
    target,
    progress: formatProgress(selectedCount, required),
    progressPct: progressPercent(selectedCount, target),
  };
}
