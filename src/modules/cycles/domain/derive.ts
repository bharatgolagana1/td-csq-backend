/**
 * Derived cycle schedule, as the 2017 product did it: the admin gives an
 * initiation date and the defaults (`settings.defaults`) produce the two
 * windows and the reminder schedule (REQUIREMENTS.md §11, §18, §19;
 * ARCHITECTURE.md §6 `POST /cycles`, §7 "Cycle clock").
 */
import {
  instantOf,
  type CalendarDate,
  type CycleWindows,
  type InstantLike,
  type ReminderPolicy,
} from './types.js';
import { isCalendarDate, localDateOf, toInstant, windowEdge } from './windows.js';

export interface DeriveDefaults {
  samplingDays: number;
  assessmentDays: number;
}

export interface DeriveWindowsInput {
  /** The day sampling opens, `YYYY-MM-DD` in `tz`. */
  initiationDate: CalendarDate;
  tz: string;
  defaults: DeriveDefaults;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${label} must be a whole number ≥ 1 (got ${value})`);
}

/** Calendar arithmetic on `YYYY-MM-DD` strings, independent of any time zone. */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  if (!isCalendarDate(date)) throw new RangeError(`Invalid calendar date "${date}"`);
  if (!Number.isInteger(days)) throw new RangeError(`days must be an integer (got ${days})`);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * sampling.start  = initiation day 00:00
 * sampling.end    = sampling.start + samplingDays, 00:00 (the morning after the last sampling day)
 * assessment.start = sampling.end (the same instant: midnight activation, REQUIREMENTS §15)
 * assessment.end  = assessment.start + assessmentDays, 00:00
 */
export function deriveWindows({ initiationDate, tz, defaults }: DeriveWindowsInput): CycleWindows {
  if (!isCalendarDate(initiationDate)) {
    throw new RangeError(`Invalid initiation date "${initiationDate}" (expected YYYY-MM-DD)`);
  }
  assertPositiveInteger(defaults.samplingDays, 'samplingDays');
  assertPositiveInteger(defaults.assessmentDays, 'assessmentDays');

  const samplingEndDate = addCalendarDays(initiationDate, defaults.samplingDays);
  const assessmentEndDate = addCalendarDays(samplingEndDate, defaults.assessmentDays);

  return {
    sampling: {
      start: windowEdge(`${initiationDate}T00:00`, tz),
      end: windowEdge(`${samplingEndDate}T00:00`, tz),
    },
    assessment: {
      start: windowEdge(`${samplingEndDate}T00:00`, tz),
      end: windowEdge(`${assessmentEndDate}T00:00`, tz),
    },
  };
}

export interface ReminderScheduleOptions {
  tz: string;
  /** The publish instant: reminders already in the past at publish time are dropped. */
  now?: Date;
  /** Local hour of day for reminders; default 09:00. */
  hourLocal?: number;
}

/**
 * Reminder k (1..count) fires on the window's start day + k·everyDays at
 * `hourLocal` in `tz`. Reminders at or after the window end, and reminders
 * before `now`, are dropped — the schedule never outlives its window.
 * Returns ISO-8601 UTC instants in ascending order.
 */
export function deriveReminderSchedule(
  window: { start: InstantLike; end: InstantLike },
  policy: ReminderPolicy,
  options: ReminderScheduleOptions,
): string[] {
  if (!Number.isInteger(policy.count) || policy.count < 0) {
    throw new RangeError(`reminders.count must be a whole number ≥ 0 (got ${policy.count})`);
  }
  if (policy.count > 0) assertPositiveInteger(policy.everyDays, 'reminders.everyDays');
  const hour = options.hourLocal ?? 9;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError(`hourLocal must be 0..23 (got ${hour})`);

  const start = instantOf(window.start);
  const end = instantOf(window.end).getTime();
  const notBefore = options.now?.getTime() ?? Number.NEGATIVE_INFINITY;
  const startDate = localDateOf(start, options.tz);
  const wallHour = String(hour).padStart(2, '0');

  const schedule: string[] = [];
  for (let k = 1; k <= policy.count; k += 1) {
    const date = addCalendarDays(startDate, k * policy.everyDays);
    const at = toInstant({ wall: `${date}T${wallHour}:00`, tz: options.tz });
    const ms = at.getTime();
    if (ms >= end) break;
    if (ms < notBefore) continue;
    schedule.push(at.toISOString());
  }
  return schedule;
}

export interface NextReminder {
  /** Position in the schedule (0-based). */
  index: number;
  at: string;
  /** True when `at ≤ now`: the scheduler should send it on this tick. */
  due: boolean;
}

/**
 * The next reminder after `sent` have gone out, or null when the schedule is
 * exhausted. `sent` is the count already sent (`remindersSent`).
 */
export function nextReminder(schedule: readonly string[], sent: number, now: Date): NextReminder | null {
  if (!Number.isInteger(sent) || sent < 0) throw new RangeError(`sent must be a whole number ≥ 0 (got ${sent})`);
  const at = schedule[sent];
  if (at === undefined) return null;
  return { index: sent, at, due: new Date(at).getTime() <= now.getTime() };
}
