import { describe, expect, it } from 'vitest';

import { weightsFor } from '../../../src/modules/scoring/engine/index.js';

describe('weightsFor', () => {
  it('EQUAL ignores weightPct and weighs every child 1', () => {
    expect(weightsFor('EQUAL', [{ weightPct: 60 }, { weightPct: 40 }, {}])).toEqual([1, 1, 1]);
  });

  it('WEIGHTED uses weightPct when every child declares one', () => {
    expect(weightsFor('WEIGHTED', [{ weightPct: 60 }, { weightPct: 40 }])).toEqual([60, 40]);
    expect(weightsFor('WEIGHTED', [{ weightPct: 0 }, { weightPct: 100 }])).toEqual([0, 100]);
  });

  it('WEIGHTED falls back to equal weights when any child lacks a weight', () => {
    expect(weightsFor('WEIGHTED', [{ weightPct: 60 }, {}])).toEqual([1, 1]);
    expect(weightsFor('WEIGHTED', [{}, {}])).toEqual([1, 1]);
  });

  it('WEIGHTED rejects negative weights by falling back to equal weights', () => {
    expect(weightsFor('WEIGHTED', [{ weightPct: -5 }, { weightPct: 105 }])).toEqual([1, 1]);
  });

  it('has nothing to weigh for an empty sibling set', () => {
    expect(weightsFor('WEIGHTED', [])).toEqual([]);
    expect(weightsFor('EQUAL', [])).toEqual([]);
  });
});
