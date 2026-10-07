/**
 * Cycle-over-cycle comparison: attaches the previous cycle's figure and the
 * delta to each current row that has a counterpart (same level and ref) in the
 * previous cycle. The service chooses the previous cycle ("the most recent
 * SCORED cycle of the same type", ARCHITECTURE.md §7).
 *
 * Rows are matched on `level` + `refId`. OVERALL always matches; question,
 * subcategory and category rows match only while the two cycles pin the same
 * survey version (a new version creates new ids), which is the service's
 * concern.
 *
 * `previous` is attached whenever the ref exists in the previous cycle, even
 * when its mean was suppressed (`mean: null`). `delta` is attached only when
 * both means are known, as `current − previous` rounded to 2 dp.
 */

import { roundHalfUp } from './means.js';
import type { PreviousCycleScores, ScoreRow, WithPrevious } from './types.js';

export function rowKey(row: Pick<ScoreRow, 'level' | 'refId'>): string {
  return `${row.level}:${row.refId}`;
}

export function withPrevious<T extends ScoreRow>(
  current: readonly T[],
  previous: PreviousCycleScores | null | undefined,
): (T & WithPrevious)[] {
  if (!previous) return current.map((row) => ({ ...row }));

  const previousByKey = new Map(previous.rows.map((row) => [rowKey(row), row]));

  return current.map((row) => {
    const counterpart = previousByKey.get(rowKey(row));
    if (!counterpart) return { ...row };

    const out: T & WithPrevious = {
      ...row,
      previous: { cycleId: previous.cycleId, mean: counterpart.customer.mean },
    };
    if (row.customer.mean !== null && counterpart.customer.mean !== null) {
      out.delta = roundHalfUp(row.customer.mean - counterpart.customer.mean, 2);
    }
    return out;
  });
}
