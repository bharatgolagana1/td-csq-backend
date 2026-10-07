/**
 * Turns `settings.scoring.weightingMode` plus the survey's `weightPct` values
 * into the weights a parent level uses over its children.
 *
 * - EQUAL: every child weighs 1.
 * - WEIGHTED: the children's `weightPct` when every child in the sibling set
 *   declares one; otherwise the set falls back to equal weights. A set is the
 *   categories under OVERALL, the subcategories plus direct questions under a
 *   category, or the questions under a subcategory. Subcategories carry no
 *   `weightPct` in the data model, so a category that has subcategories is
 *   always equal-weighted across its children; question weights only act
 *   inside a subcategory (or among a category's direct questions).
 *
 * Weights are relative: they need not sum to 100. A child whose score is
 * missing drops out and its weight is redistributed (see `weightedMean`).
 */

import type { WeightingMode } from './types.js';

export interface Weightable {
  weightPct?: number;
}

export function weightsFor(mode: WeightingMode, children: readonly Weightable[]): number[] {
  if (mode === 'WEIGHTED' && everyChildHasWeight(children)) {
    return children.map((child) => child.weightPct ?? 0);
  }
  return children.map(() => 1);
}

function everyChildHasWeight(children: readonly Weightable[]): boolean {
  return (
    children.length > 0 &&
    children.every((child) => typeof child.weightPct === 'number' && child.weightPct >= 0)
  );
}
