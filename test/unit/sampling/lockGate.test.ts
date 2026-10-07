import { describe, expect, it } from 'vitest';

import { evaluateLock, formatProgress, progressPercent } from '../../../src/modules/sampling/domain/lockGate.js';

describe('evaluateLock', () => {
  it('locks once the minimum is reached', () => {
    const result = evaluateLock({ required: 50, selectedCount: 50, eligibleCount: 120 });
    expect(result).toMatchObject({ lockable: true, reason: null, shortfallRule: null, remaining: 0, progress: '50 / 50', progressPct: 100 });
    expect(evaluateLock({ required: 50, selectedCount: 63, eligibleCount: 120 }).lockable).toBe(true);
  });

  it('refuses below the minimum and shows the counter', () => {
    const result = evaluateLock({ required: 50, selectedCount: 37, eligibleCount: 120 });
    expect(result).toMatchObject({
      lockable: false,
      reason: 'BELOW_MINIMUM',
      shortfallRule: null,
      remaining: 13,
      target: 50,
      progress: '37 / 50',
      progressPct: 74,
    });
  });

  it('select-all rule: with fewer eligible than required, every eligible entry must be selected', () => {
    const partial = evaluateLock({ required: 50, selectedCount: 20, eligibleCount: 30 });
    expect(partial).toMatchObject({
      lockable: false,
      reason: 'SELECT_ALL_REQUIRED',
      shortfallRule: 'SELECT_ALL',
      remaining: 10,
      target: 30,
      progress: '20 / 50',
      progressPct: 67,
    });

    const all = evaluateLock({ required: 50, selectedCount: 30, eligibleCount: 30 });
    expect(all).toMatchObject({ lockable: true, reason: null, shortfallRule: 'SELECT_ALL', remaining: 0, progress: '30 / 50' });
  });

  it('never locks an empty selection, even under select-all', () => {
    expect(evaluateLock({ required: 50, selectedCount: 0, eligibleCount: 120 }).reason).toBe('NOTHING_SELECTED');
    expect(evaluateLock({ required: 50, selectedCount: 0, eligibleCount: 0 })).toMatchObject({
      lockable: false,
      reason: 'NOTHING_SELECTED',
      shortfallRule: 'SELECT_ALL',
    });
    expect(evaluateLock({ required: 0, selectedCount: 0, eligibleCount: 10 }).lockable).toBe(false);
  });

  it('a zero minimum locks with any selection', () => {
    expect(evaluateLock({ required: 0, selectedCount: 1, eligibleCount: 10 })).toMatchObject({ lockable: true, progressPct: 100 });
  });

  it('rejects negative or fractional counts', () => {
    expect(() => evaluateLock({ required: -1, selectedCount: 0, eligibleCount: 0 })).toThrow(RangeError);
    expect(() => evaluateLock({ required: 10, selectedCount: 1.5, eligibleCount: 0 })).toThrow(RangeError);
  });
});

describe('progress helpers', () => {
  it('formats the counter and caps the percentage', () => {
    expect(formatProgress(37, 50)).toBe('37 / 50');
    expect(progressPercent(37, 50)).toBe(74);
    expect(progressPercent(60, 50)).toBe(100);
    expect(progressPercent(0, 0)).toBe(100);
    expect(progressPercent(1, 3)).toBe(33);
  });
});
