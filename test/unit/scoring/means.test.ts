import { describe, expect, it } from 'vitest';

import {
  meanExcludingNa,
  round2,
  roundHalfUp,
  weightedMean,
} from '../../../src/modules/scoring/engine/index.js';

describe('meanExcludingNa', () => {
  it('skips NA so it neither reduces nor inflates the score (REQUIREMENTS §22)', () => {
    expect(meanExcludingNa([5, 4, null, 3])).toBe(4);
  });

  it('returns null, not zero, when nothing was rated', () => {
    expect(meanExcludingNa([])).toBeNull();
    expect(meanExcludingNa([null, null])).toBeNull();
  });

  it('keeps the exact value; it is not an output boundary', () => {
    expect(meanExcludingNa([5, 4, 4])).toBe(13 / 3);
    expect(meanExcludingNa([5, 4, 4])).not.toBe(4.33);
  });
});

describe('weightedMean', () => {
  it('weights the present children', () => {
    expect(weightedMean([{ mean: 4.5, weight: 50 }, { mean: 4, weight: 30 }, { mean: 3.5, weight: 20 }])).toBe(4.15);
  });

  it('redistributes the weight of a child without a score to the others', () => {
    // 50 / 30 with the 20 missing → 50/80 and 30/80, not 4.15 and not (4.5×50 + 4×30)/100.
    expect(weightedMean([{ mean: 4.5, weight: 50 }, { mean: 4, weight: 30 }, { mean: null, weight: 20 }])).toBe(4.3125);
  });

  it('is equal-weighted when every weight is the same', () => {
    expect(weightedMean([{ mean: 5, weight: 1 }, { mean: 3, weight: 1 }])).toBe(4);
  });

  it('returns null when no child is present or every weight is non-positive', () => {
    expect(weightedMean([])).toBeNull();
    expect(weightedMean([{ mean: null, weight: 50 }])).toBeNull();
    expect(weightedMean([{ mean: 4, weight: 0 }, { mean: 5, weight: -1 }])).toBeNull();
  });

  it('ignores a child with a non-positive weight', () => {
    expect(weightedMean([{ mean: 4, weight: 0 }, { mean: 5, weight: 10 }])).toBe(5);
  });
});

describe('roundHalfUp', () => {
  it('rounds half up at 2 dp on the decimal representation', () => {
    expect(roundHalfUp(4.125)).toBe(4.13);
    expect(roundHalfUp(1.005)).toBe(1.01);
    expect(roundHalfUp(2.675)).toBe(2.68);
    expect(roundHalfUp(4.3125)).toBe(4.31);
    expect(roundHalfUp(13 / 3)).toBe(4.33);
    expect(roundHalfUp(14 / 3)).toBe(4.67);
  });

  it('rounds half away from zero for negative deltas and never yields -0', () => {
    expect(roundHalfUp(-0.005)).toBe(-0.01);
    expect(roundHalfUp(-0.004)).toBe(0);
    expect(Object.is(roundHalfUp(-0.004), -0)).toBe(false);
  });

  it('supports other precisions', () => {
    expect(roundHalfUp(4.5, 0)).toBe(5);
    expect(roundHalfUp(4.4444, 3)).toBe(4.444);
  });

  it('round2 passes null through', () => {
    expect(round2(null)).toBeNull();
    expect(round2(4.666)).toBe(4.67);
  });
});
