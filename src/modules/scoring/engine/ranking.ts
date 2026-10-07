/**
 * Dense ranking of operators on their published (2 dp) overall customer mean,
 * ARCHITECTURE.md §7: "dense ranking on the overall customer mean (2 dp)
 * among operators in the cycle with a non-suppressed score (`rankOf` = that
 * count)".
 *
 * Higher is better; operators with equal 2-dp means share a rank and the next
 * distinct mean takes the next integer (4.50, 4.50, 4.20 → 1, 1, 2). An
 * operator without a mean (suppressed or unscored) gets `rank: null` and is
 * not counted in `rankOf`. The input order is preserved in the output.
 */

import { roundHalfUp } from './means.js';
import type { RankEntry, RankedEntry } from './types.js';

export function rankOperators(entries: readonly RankEntry[]): RankedEntry[] {
  const means = entries.map((entry) => (entry.mean === null ? null : roundHalfUp(entry.mean, 2)));
  const scored = means.filter((mean): mean is number => mean !== null);
  const distinctDescending = [...new Set(scored)].sort((a, b) => b - a);
  const rankOf = scored.length;

  return entries.map((entry, i) => {
    const mean = means[i] ?? null;
    return {
      acoId: entry.acoId,
      mean,
      rank: mean === null ? null : distinctDescending.indexOf(mean) + 1,
      rankOf,
    };
  });
}
