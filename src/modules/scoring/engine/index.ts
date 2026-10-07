/**
 * The pure scoring engine. No IO, no clock, no database: the scoring service
 * loads the documents and calls these functions.
 */

export * from './types.js';
export { meanExcludingNa, weightedMean, roundHalfUp, round2 } from './means.js';
export type { WeightedChild } from './means.js';
export { weightsFor } from './weights.js';
export type { Weightable } from './weights.js';
export { scoreAssessments } from './rollup.js';
export { feedbackDistribution } from './distribution.js';
export { rankOperators } from './ranking.js';
export { rollupAirport, DEFAULT_MIN_COVERED_SHARE_PCT } from './airport.js';
export { withPrevious, rowKey } from './comparison.js';
