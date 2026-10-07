import { describe, expect, it } from 'vitest';

import { rankOperators } from '../../../src/modules/scoring/engine/index.js';

describe('rankOperators', () => {
  it('ranks densely, ties share a rank, suppressed operators are unranked and not counted', () => {
    const ranked = rankOperators([
      { acoId: 'a', mean: 4.5 },
      { acoId: 'b', mean: 4.5 },
      { acoId: 'c', mean: 4.2 },
      { acoId: 'd', mean: null },
      { acoId: 'e', mean: 3.9 },
    ]);
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 1, 2, null, 3]);
    expect(ranked.every((entry) => entry.rankOf === 4)).toBe(true);
  });

  it('compares on the 2-dp mean so near-equal means tie', () => {
    const ranked = rankOperators([
      { acoId: 'a', mean: 4.004 },
      { acoId: 'b', mean: 4.001 },
      { acoId: 'c', mean: 3.996 },
    ]);
    expect(ranked.map((entry) => entry.mean)).toEqual([4, 4, 4]);
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 1, 1]);
  });

  it('preserves the input order', () => {
    const ranked = rankOperators([{ acoId: 'low', mean: 2 }, { acoId: 'high', mean: 5 }]);
    expect(ranked.map((entry) => [entry.acoId, entry.rank])).toEqual([['low', 2], ['high', 1]]);
  });

  it('handles nothing to rank', () => {
    expect(rankOperators([])).toEqual([]);
    expect(rankOperators([{ acoId: 'a', mean: null }])).toEqual([{ acoId: 'a', mean: null, rank: null, rankOf: 0 }]);
  });
});
