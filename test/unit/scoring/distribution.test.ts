import { describe, expect, it } from 'vitest';

import { feedbackDistribution } from '../../../src/modules/scoring/engine/index.js';

import { customer, integer, seededRandom, selfAssessment } from './fixtures.js';


const sumPct = (buckets: readonly { pct: number }[]): number =>
  Math.round(buckets.reduce((sum, bucket) => sum + bucket.pct, 0) * 100) / 100;

describe('feedbackDistribution', () => {
  it('labels the buckets Excellent … Poor, NA in that order', () => {
    expect(feedbackDistribution([]).map((bucket) => [bucket.rating, bucket.label])).toEqual([
      [5, 'Excellent'],
      [4, 'Very Good'],
      [3, 'Good'],
      [2, 'Fair'],
      [1, 'Poor'],
      [null, 'NA'],
    ]);
  });

  it('counts every customer answer and gives percentages that sum to 100', () => {
    const buckets = feedbackDistribution([
      customer('a', 'FF', { q1: 5, q2: 4, q3: 'NA' }),
      customer('b', 'CB', { q1: 5, q2: 1, q3: 2 }),
      customer('c', 'CB', { q1: 3, q2: 3, q3: 'NA' }),
    ]);
    expect(buckets.map((bucket) => bucket.count)).toEqual([2, 1, 2, 1, 1, 2]);
    // 2/9 = 22.222…, 1/9 = 11.111…; the floors sum to 99.99 and the first 2/9 bucket has the largest remainder.
    expect(buckets.map((bucket) => bucket.pct)).toEqual([22.23, 11.11, 22.22, 11.11, 11.11, 22.22]);
    expect(sumPct(buckets)).toBe(100);
  });

  it('resolves 1/3, 1/3, 1/3 to exactly 100 by largest remainder', () => {
    const buckets = feedbackDistribution([customer('a', 'FF', { q1: 5, q2: 4, q3: 3 })]);
    expect(buckets.map((bucket) => bucket.pct)).toEqual([33.34, 33.33, 33.33, 0, 0, 0]);
    expect(sumPct(buckets)).toBe(100);
  });

  it('ignores SELF assessments and unanswered entries', () => {
    const buckets = feedbackDistribution([selfAssessment('s', { q1: 5, q2: 5 }), customer('a', 'FF', { q1: null, q2: 2 })]);
    expect(buckets.map((bucket) => bucket.count)).toEqual([0, 0, 0, 1, 0, 0]);
    expect(buckets.map((bucket) => bucket.pct)).toEqual([0, 0, 0, 100, 0, 0]);
  });

  it('restricts to the given question ids', () => {
    const buckets = feedbackDistribution([customer('a', 'FF', { q1: 5, retired: 1 })], new Set(['q1']));
    expect(buckets.map((bucket) => bucket.count)).toEqual([1, 0, 0, 0, 0, 0]);
  });

  it('reports zeros, not NaN, without answers', () => {
    for (const bucket of feedbackDistribution([])) {
      expect(bucket.count).toBe(0);
      expect(bucket.pct).toBe(0);
    }
  });

  it('property: percentages sum to exactly 100 and stay within 0.01 of the exact share', () => {
    const random = seededRandom(7);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const assessments = Array.from({ length: integer(random, 1, 12) }, (_, i) =>
        customer(`a${i}`, 'FF', Object.fromEntries(
          Array.from({ length: integer(random, 1, 6) }, (__, j) => [`q${j}`, integer(random, 0, 5) === 0 ? 'NA' : (integer(random, 1, 5) as 1 | 2 | 3 | 4 | 5)]),
        )),
      );
      const buckets = feedbackDistribution(assessments);
      const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
      expect(sumPct(buckets)).toBe(100);
      for (const bucket of buckets) {
        expect(Math.abs(bucket.pct - (bucket.count * 100) / total)).toBeLessThanOrEqual(0.01 + 1e-9);
      }
    }
  });
});
