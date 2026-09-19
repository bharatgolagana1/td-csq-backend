/**
 * Cycle window predicates.
 *
 * Boundaries are stored as an explicit triple rather than a bare Date: the wall
 * time an administrator typed, the zone it was typed in, and the resolved UTC
 * instant. "Midnight on the 12th" in Asia/Kolkata is a different instant from
 * midnight anywhere else, and a cycle that opens an hour early because a server
 * moved region is not recoverable after invitations have gone out.
 */
export interface CycleBoundary {
  /** ISO local date-time as entered, e.g. 2026-04-12T00:00:00 */
  readonly wall: string;
  /** IANA zone, e.g. Asia/Kolkata */
  readonly tz: string;
  /** Resolved instant. The only field arithmetic ever uses. */
  readonly utc: Date;
}

export interface CycleWindows {
  readonly samplingOpens: CycleBoundary;
  readonly samplingCloses: CycleBoundary;
  readonly assessmentOpens: CycleBoundary;
  readonly assessmentCloses: CycleBoundary;
}

export type WindowName = 'SAMPLING' | 'ASSESSMENT';

export function isOpen(windows: CycleWindows, which: WindowName, now: Date): boolean {
  const [from, to] =
    which === 'SAMPLING'
      ? [windows.samplingOpens.utc, windows.samplingCloses.utc]
      : [windows.assessmentOpens.utc, windows.assessmentCloses.utc];
  return now >= from && now < to;
}

export type OrderingProblem =
  | 'SAMPLING_ENDS_BEFORE_IT_OPENS'
  | 'ASSESSMENT_ENDS_BEFORE_IT_OPENS'
  | 'ASSESSMENT_OPENS_BEFORE_SAMPLING_OPENS';

/**
 * Validates the orderings that must hold. Note what is deliberately permitted:
 * the assessment window may open before sampling closes. Late-added customers
 * being sampled after assessment has begun is an explicit requirement, not an
 * error, and forbidding the overlap would make it unimplementable.
 */
export function validateOrdering(w: CycleWindows): OrderingProblem[] {
  const problems: OrderingProblem[] = [];
  if (w.samplingCloses.utc <= w.samplingOpens.utc) problems.push('SAMPLING_ENDS_BEFORE_IT_OPENS');
  if (w.assessmentCloses.utc <= w.assessmentOpens.utc) problems.push('ASSESSMENT_ENDS_BEFORE_IT_OPENS');
  if (w.assessmentOpens.utc < w.samplingOpens.utc) problems.push('ASSESSMENT_OPENS_BEFORE_SAMPLING_OPENS');
  return problems;
}

/**
 * Reminders are resolved at send time against who has not yet submitted, so
 * there is no cancellation path to get wrong. A reminder scheduled for an
 * assessor who has since submitted simply finds no recipient.
 */
export function remindersWithin(windows: CycleWindows, dates: readonly Date[]): Date[] {
  const from = windows.assessmentOpens.utc;
  const to = windows.assessmentCloses.utc;
  return dates.filter((d) => d > from && d < to).sort((a, b) => a.getTime() - b.getTime());
}
