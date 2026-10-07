/**
 * Shared vocabulary of the cycle domain (ARCHITECTURE.md §5 `cycles`).
 * Pure types and constant lists; no behaviour.
 */

export type SurveyType = 'DOMESTIC' | 'INTERNATIONAL';
export const SURVEY_TYPES: readonly SurveyType[] = ['DOMESTIC', 'INTERNATIONAL'];

export type CycleType = SurveyType | 'BOTH';
export const CYCLE_TYPES: readonly CycleType[] = ['DOMESTIC', 'INTERNATIONAL', 'BOTH'];

export type CycleStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'SAMPLING_OPEN'
  | 'SAMPLING_CLOSED'
  | 'ASSESSMENT_OPEN'
  | 'ASSESSMENT_CLOSED'
  | 'SCORED'
  | 'ARCHIVED';

export const CYCLE_STATUSES: readonly CycleStatus[] = [
  'DRAFT',
  'PUBLISHED',
  'SAMPLING_OPEN',
  'SAMPLING_CLOSED',
  'ASSESSMENT_OPEN',
  'ASSESSMENT_CLOSED',
  'SCORED',
  'ARCHIVED',
];

/** Wall-clock entry in the cycle's time zone, `YYYY-MM-DDTHH:mm` (minute precision, no zone). */
export type WallClock = string;

/** Calendar date, `YYYY-MM-DD`. */
export type CalendarDate = string;

/** One edge of a window as stored on the cycle: what the admin typed and the instant it means. */
export interface WindowEdge {
  wall: WallClock;
  utc: Date;
}

export interface CycleWindow {
  start: WindowEdge;
  end: WindowEdge;
}

export interface CycleWindows {
  sampling: CycleWindow;
  assessment: CycleWindow;
}

/** Reminder policy for one window (`cycles.reminders.sampling` / `.assessment`). */
export interface ReminderPolicy {
  count: number;
  everyDays: number;
}

/** An instant, given either directly or as a stored window edge. */
export type InstantLike = Date | WindowEdge;

export function instantOf(value: InstantLike): Date {
  return value instanceof Date ? value : value.utc;
}
