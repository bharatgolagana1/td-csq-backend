/**
 * Feedback distribution: how the customer answers split across the rating
 * scale and NA. Feeds the operator dashboard's `feedbackDistribution`.
 *
 * Percentages are allotted by the largest-remainder method at 2 dp so that
 * the six buckets always sum to exactly 100.00 (plain rounding of 1/3, 1/3,
 * 1/3 would give 99.99). With no answers every `pct` is 0.
 */

import type { DistributionBucket, Rating, SubmittedAssessment } from './types.js';

const BUCKETS: readonly { rating: Rating | null; label: DistributionBucket['label'] }[] = [
  { rating: 5, label: 'Excellent' },
  { rating: 4, label: 'Very Good' },
  { rating: 3, label: 'Good' },
  { rating: 2, label: 'Fair' },
  { rating: 1, label: 'Poor' },
  { rating: null, label: 'NA' },
];

/**
 * Counts every CUSTOMER answer (SELF is ignored) that is rated or NA; an
 * unanswered entry counts for nothing. `questionIds`, when given, restricts
 * the count to those questions (the service passes the active questions of
 * the survey version).
 */
export function feedbackDistribution(
  assessments: readonly SubmittedAssessment[],
  questionIds?: ReadonlySet<string>,
): DistributionBucket[] {
  const counts = new Map<Rating | null, number>(BUCKETS.map((bucket) => [bucket.rating, 0]));

  for (const assessment of assessments) {
    if (assessment.kind !== 'CUSTOMER') continue;
    for (const answer of assessment.answers) {
      if (questionIds && !questionIds.has(answer.questionId)) continue;
      const key = answer.na ? null : answer.rating;
      if (key === null && !answer.na) continue; // unanswered
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const ordered = BUCKETS.map((bucket) => counts.get(bucket.rating) ?? 0);
  const pct = percentagesSummingTo100(ordered);
  return BUCKETS.map((bucket, i) => ({
    rating: bucket.rating,
    label: bucket.label,
    count: ordered[i] ?? 0,
    pct: pct[i] ?? 0,
  }));
}

/** Largest-remainder apportionment of 100.00 (10 000 hundredths) over `counts`. */
function percentagesSummingTo100(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return counts.map(() => 0);

  const exact = counts.map((count) => (count * 10_000) / total);
  const floors = exact.map((value) => Math.floor(value));
  let remaining = 10_000 - floors.reduce((sum, value) => sum + value, 0);

  const byRemainder = exact
    .map((value, i) => ({ i, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of byRemainder) {
    if (remaining <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remaining -= 1;
  }

  return floors.map((hundredths) => hundredths / 100);
}
