/**
 * The sampling lock gate.
 *
 * An operator chooses who grades it, which is the sharpest conflict of interest
 * in the product. The gate is therefore deliberately simple and total: a batch
 * either satisfies the rule or it is refused, and every refusal states what
 * would fix it.
 *
 * The one real-world exception comes straight from the CSQ screens: an operator
 * whose entire customer directory is smaller than the cycle minimum cannot reach
 * that minimum. It must then lock everyone it has, and the shortfall is surfaced
 * rather than silently forgiven.
 */

export type GateOutcome =
  | { readonly ok: true; readonly mustSelectAll: false }
  | { readonly ok: true; readonly mustSelectAll: true; readonly shortfall: number }
  | { readonly ok: false; readonly reason: GateFailure; readonly needed: number };

export type GateFailure = 'BELOW_MINIMUM' | 'NOT_ALL_SELECTED' | 'EMPTY_DIRECTORY';

export interface GateInput {
  /** Contacts eligible to be sampled: valid, not hard-bounced, right form scope. */
  readonly eligibleCount: number;
  /** Contacts the operator has actually selected for this batch. */
  readonly selectedCount: number;
  /** The cycle's minimum sampling size. */
  readonly minimumSamplingSize: number;
}

export function evaluateLockGate(input: GateInput): GateOutcome {
  const { eligibleCount, selectedCount, minimumSamplingSize } = input;

  if (eligibleCount <= 0) {
    return { ok: false, reason: 'EMPTY_DIRECTORY', needed: minimumSamplingSize };
  }

  if (eligibleCount < minimumSamplingSize) {
    // Cannot reach the minimum. Everyone available must be locked.
    if (selectedCount < eligibleCount) {
      return { ok: false, reason: 'NOT_ALL_SELECTED', needed: eligibleCount - selectedCount };
    }
    return { ok: true, mustSelectAll: true, shortfall: minimumSamplingSize - eligibleCount };
  }

  if (selectedCount < minimumSamplingSize) {
    return { ok: false, reason: 'BELOW_MINIMUM', needed: minimumSamplingSize - selectedCount };
  }

  return { ok: true, mustSelectAll: false };
}

/** Human-facing explanation. The UI shows this verbatim rather than inventing its own. */
export function explainGate(outcome: GateOutcome, minimum: number): string {
  if (outcome.ok) {
    return outcome.mustSelectAll
      ? `Locked with ${outcome.shortfall} fewer than the minimum of ${minimum}, because that is every eligible customer on record.`
      : 'Ready to lock.';
  }
  switch (outcome.reason) {
    case 'EMPTY_DIRECTORY':
      return 'Add customers before locking a sample.';
    case 'NOT_ALL_SELECTED':
      return `You have fewer customers than the minimum of ${minimum}, so all of them must be selected. ${outcome.needed} still to select.`;
    case 'BELOW_MINIMUM':
      return `Select ${outcome.needed} more to reach the minimum of ${minimum}.`;
  }
}
