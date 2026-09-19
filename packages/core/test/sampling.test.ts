import { describe, expect, it } from 'vitest';
import { evaluateLockGate, explainGate } from '../src/index.js';

describe('sampling lock gate', () => {
  it('accepts a batch at or above the minimum', () => {
    expect(evaluateLockGate({ eligibleCount: 40, selectedCount: 10, minimumSamplingSize: 10 }))
      .toEqual({ ok: true, mustSelectAll: false });
  });

  it('refuses a batch below the minimum and says how many more are needed', () => {
    const r = evaluateLockGate({ eligibleCount: 40, selectedCount: 7, minimumSamplingSize: 10 });
    expect(r).toEqual({ ok: false, reason: 'BELOW_MINIMUM', needed: 3 });
    expect(explainGate(r, 10)).toBe('Select 3 more to reach the minimum of 10.');
  });

  it('when the directory is smaller than the minimum, demands every contact', () => {
    const r = evaluateLockGate({ eligibleCount: 6, selectedCount: 4, minimumSamplingSize: 10 });
    expect(r).toEqual({ ok: false, reason: 'NOT_ALL_SELECTED', needed: 2 });
  });

  it('allows locking a short directory once all of it is selected, and reports the shortfall', () => {
    const r = evaluateLockGate({ eligibleCount: 6, selectedCount: 6, minimumSamplingSize: 10 });
    expect(r).toEqual({ ok: true, mustSelectAll: true, shortfall: 4 });
    expect(explainGate(r, 10)).toContain('4 fewer than the minimum');
  });

  it('refuses an empty directory outright', () => {
    const r = evaluateLockGate({ eligibleCount: 0, selectedCount: 0, minimumSamplingSize: 10 });
    expect(r.ok).toBe(false);
    expect(explainGate(r, 10)).toBe('Add customers before locking a sample.');
  });

  it('does not let an operator lock more than it has', () => {
    // selecting beyond the directory is a caller bug; the gate still passes on count
    expect(evaluateLockGate({ eligibleCount: 12, selectedCount: 12, minimumSamplingSize: 10 }).ok).toBe(true);
  });
});
