import { describe, expect, it } from 'vitest';

import type { ScoreRow } from '../../../src/modules/scoring/engine/index.js';
import { OVERALL_REF_ID, rowKey, withPrevious } from '../../../src/modules/scoring/engine/index.js';

function scoreRow(level: ScoreRow['level'], refId: string, mean: number | null, suppressed = false): ScoreRow {
  const base: ScoreRow = {
    level,
    refId,
    customer: { mean, n: mean === null ? 0 : 5, naCount: 0, byType: { FF: { mean, n: 3 }, CB: { mean, n: 2 } } },
    self: { mean: null, n: 0 },
  };
  return suppressed ? { ...base, suppressed: 'INSUFFICIENT_RESPONSES' } : base;
}

describe('withPrevious', () => {
  const current = [scoreRow('OVERALL', OVERALL_REF_ID, 4.33), scoreRow('CATEGORY', 'c1', 4.5), scoreRow('CATEGORY', 'c2', 3.8)];

  it('attaches previous and a 2-dp delta where the previous cycle has the same level and ref', () => {
    const rows = withPrevious(current, {
      cycleId: 'cycle-1',
      rows: [scoreRow('OVERALL', OVERALL_REF_ID, 4.2), scoreRow('CATEGORY', 'c1', 4.6)],
    });
    expect(rows[0]).toMatchObject({ previous: { cycleId: 'cycle-1', mean: 4.2 }, delta: 0.13 });
    expect(rows[1]).toMatchObject({ previous: { cycleId: 'cycle-1', mean: 4.6 }, delta: -0.1 });
    expect(rows[2]?.previous).toBeUndefined();
    expect(rows[2]?.delta).toBeUndefined();
  });

  it('matches on level as well as ref', () => {
    const rows = withPrevious(current, { cycleId: 'p', rows: [scoreRow('SUBCATEGORY', 'c1', 1)] });
    expect(rows[1]?.previous).toBeUndefined();
  });

  it('attaches previous without a delta when the previous figure was suppressed', () => {
    const rows = withPrevious(current, { cycleId: 'p', rows: [scoreRow('OVERALL', OVERALL_REF_ID, null, true)] });
    expect(rows[0]?.previous).toEqual({ cycleId: 'p', mean: null });
    expect(rows[0]?.delta).toBeUndefined();
  });

  it('attaches previous without a delta when the current figure is suppressed', () => {
    const rows = withPrevious([scoreRow('OVERALL', OVERALL_REF_ID, null, true)], {
      cycleId: 'p',
      rows: [scoreRow('OVERALL', OVERALL_REF_ID, 4)],
    });
    expect(rows[0]?.previous).toEqual({ cycleId: 'p', mean: 4 });
    expect(rows[0]?.delta).toBeUndefined();
    expect(rows[0]?.suppressed).toBe('INSUFFICIENT_RESPONSES');
  });

  it('returns untouched copies without a previous cycle', () => {
    for (const previous of [null, undefined]) {
      const rows = withPrevious(current, previous);
      expect(rows).toEqual(current);
      expect(rows[0]).not.toBe(current[0]);
    }
  });

  it('keeps extra properties of the current rows', () => {
    const decorated = [{ ...scoreRow('OVERALL', OVERALL_REF_ID, 4), rank: 2, rankOf: 5 }];
    const rows = withPrevious(decorated, { cycleId: 'p', rows: [scoreRow('OVERALL', OVERALL_REF_ID, 3.5)] });
    expect(rows[0]).toMatchObject({ rank: 2, rankOf: 5, delta: 0.5 });
  });

  it('rowKey joins level and ref', () => {
    expect(rowKey({ level: 'QUESTION', refId: 'q1' })).toBe('QUESTION:q1');
  });
});
