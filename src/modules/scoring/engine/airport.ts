/**
 * Airport roll-up: the market-share weighted mean of the operators' scores at
 * one level (REQUIREMENTS.md §20, ARCHITECTURE.md §7).
 *
 *   (4.5 × 50 %) + (4.0 × 30 %) + (3.5 × 20 %) = 4.15
 *
 * - Only operators with a score (non-null mean) take part. The weighted sum is
 *   divided by the share they cover, so a suppressed operator's share is
 *   redistributed over the others (`coveredSharePct` says how much of the
 *   airport the figure rests on). With 4.5 × 50 and 4.0 × 30 and the 20 %
 *   operator suppressed: 345 / 80 = 4.3125 → 4.31, covered 80.
 * - When no operator has a positive share (no snapshot), every scored operator
 *   weighs the same and `marketShareApplied` is false; `coveredSharePct` is
 *   then the share of operators that have a score, by count.
 * - A scored operator with a missing or zero share, while others have one,
 *   carries no weight and adds nothing to the covered share.
 * - The airport mean is `null` when the covered share is below
 *   `minCoveredSharePct` (default 50): a figure resting on less than half of
 *   the airport would misrepresent it.
 *
 * Shares are expected to total 100 for the airport (the market-share API
 * enforces this); the arithmetic does not depend on it.
 */

import { round2, roundHalfUp, weightedMean } from './means.js';
import type { AirportOperatorInput, AirportRollupOptions, AirportScore } from './types.js';

export const DEFAULT_MIN_COVERED_SHARE_PCT = 50;

export function rollupAirport(
  operators: readonly AirportOperatorInput[],
  options: AirportRollupOptions = {},
): AirportScore {
  const minCovered = options.minCoveredSharePct ?? DEFAULT_MIN_COVERED_SHARE_PCT;
  const shares = operators.map((operator) =>
    typeof operator.sharePct === 'number' && Number.isFinite(operator.sharePct) ? operator.sharePct : null,
  );
  const marketShareApplied = shares.some((share) => share !== null && share > 0);
  const scored = operators.filter((operator) => operator.mean !== null);

  const weights = marketShareApplied
    ? shares.map((share) => (share !== null && share > 0 ? share : 0))
    : operators.map(() => 1);

  const coveredExact = marketShareApplied
    ? operators.reduce((sum, operator, i) => sum + (operator.mean === null ? 0 : (weights[i] ?? 0)), 0)
    : operators.length === 0
      ? 0
      : (scored.length / operators.length) * 100;

  const weighted = weightedMean(
    operators.map((operator, i) => ({ mean: operator.mean, weight: weights[i] ?? 0 })),
  );
  const mean = coveredExact < minCovered ? null : weighted;

  return {
    mean: round2(mean),
    marketShareApplied,
    coveredSharePct: roundHalfUp(coveredExact, 2),
    operators: operators.map((operator, i) => ({
      acoId: operator.acoId,
      mean: round2(operator.mean),
      sharePct: shares[i] ?? null,
      suppressed: operator.mean === null,
    })),
  };
}
