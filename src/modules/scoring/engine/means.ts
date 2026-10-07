/**
 * Arithmetic of the engine: the NA-excluding mean, the weighted mean over
 * present children, and the one rounding helper.
 *
 * Nothing here rounds except `roundHalfUp` / `round2`, and those are called
 * only when a figure leaves the engine (rollup output, airport output,
 * distribution percentages, deltas). Every intermediate mean is kept exact so
 * that a parent level is computed from unrounded children.
 */

import type { Rating } from './types.js';

/**
 * Mean of the non-NA ratings (`null` entries are NA and are skipped).
 * Returns `null` when there is nothing to average, so "no score" and "zero"
 * can never be confused.
 *
 *   meanExcludingNa([5, 4, null, 3]) === 4   // (5 + 4 + 3) / 3
 */
export function meanExcludingNa(ratings: readonly (Rating | null)[]): number | null {
  let sum = 0;
  let count = 0;
  for (const rating of ratings) {
    if (rating === null) continue;
    sum += rating;
    count += 1;
  }
  return count === 0 ? null : sum / count;
}

export interface WeightedChild {
  /** `null` when the child has no score; such a child drops out. */
  mean: number | null;
  /** Relative weight; non-positive weights contribute nothing. */
  weight: number;
}

/**
 * Weighted mean with weight normalisation over the present children.
 *
 * Only children with a non-null mean and a positive weight take part:
 * `Σ (weight × mean) / Σ weight` over those children. Because the divisor is
 * the sum of the *present* weights, a child without a score drops out and its
 * weight is redistributed to the remaining children in proportion to their own
 * weights. Example: weights 50 / 30 / 20 with the third child unscored gives
 * 50/80 and 30/80. Returns `null` when no child is present.
 */
export function weightedMean(children: readonly WeightedChild[]): number | null {
  let weightedSum = 0;
  let weightSum = 0;
  for (const child of children) {
    if (child.mean === null || !(child.weight > 0)) continue;
    weightedSum += child.weight * child.mean;
    weightSum += child.weight;
  }
  return weightSum === 0 ? null : weightedSum / weightSum;
}

/**
 * Rounds half away from zero (half-up for the positive values the engine
 * produces) to `dp` decimal places, working on the decimal representation so
 * that 1.005 → 1.01 rather than falling to the binary 1.00499…
 */
export function roundHalfUp(value: number, dp = 2): number {
  if (!Number.isFinite(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  const shifted = Number(`${magnitude}e${dp}`);
  const rounded = Number(`${Math.round(shifted)}e-${dp}`);
  const result = sign * rounded;
  return result === 0 ? 0 : result; // normalise -0
}

/** Output-boundary rounding to 2 dp that lets `null` (no score) through. */
export function round2(value: number | null): number | null {
  return value === null ? null : roundHalfUp(value, 2);
}
