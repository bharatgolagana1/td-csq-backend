/**
 * Cycle windows: wall-clock ↔ UTC conversion in the cycle's time zone and the
 * ordering rules the windows must satisfy (ARCHITECTURE.md §3 "Dates", §6
 * `POST /cycles/:id/publish`, §7 "Cycle clock").
 *
 * Conversion uses the runtime's IANA zone data through `Intl.DateTimeFormat`,
 * so it needs no library and no system time zone.
 */
import { instantOf, type CalendarDate, type InstantLike, type WallClock, type WindowEdge } from './types.js';

export const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
export const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(tz);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null = null;
  if (tz.trim() !== '') {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      formatter = null;
    }
  }
  formatters.set(tz, formatter);
  return formatter;
}

/** True when `tz` is an IANA zone the runtime knows (e.g. `Asia/Kolkata`). */
export function isValidTimeZone(tz: string): boolean {
  return formatterFor(tz) !== null;
}

function requireFormatter(tz: string): Intl.DateTimeFormat {
  const formatter = formatterFor(tz);
  if (formatter === null) throw new RangeError(`Unknown time zone "${tz}"`);
  return formatter;
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallPartsIn(formatter: Intl.DateTimeFormat, utc: Date): WallParts {
  const parts: Partial<WallParts> = {};
  for (const part of formatter.formatToParts(utc)) {
    switch (part.type) {
      case 'year':
      case 'month':
      case 'day':
      case 'hour':
      case 'minute':
      case 'second':
        parts[part.type] = Number(part.value);
        break;
      default:
        break;
    }
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** Milliseconds east of UTC that `tz` observes at the instant `utc`. */
function offsetAt(formatter: Intl.DateTimeFormat, utc: Date): number {
  const w = wallPartsIn(formatter, utc);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(utc.getTime() / 1000) * 1000;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** True when `value` is `YYYY-MM-DD` and names a real calendar day. */
export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1970 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** True when `value` is `YYYY-MM-DDTHH:mm` with a real date and a time within the day. */
export function isWallClock(value: string): boolean {
  const match = WALL_CLOCK_PATTERN.exec(value);
  if (!match) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  return isCalendarDate(`${match[1]}-${match[2]}-${match[3]}`) && hour <= 23 && minute <= 59;
}

const two = (n: number): string => String(n).padStart(2, '0');

function wallOf(formatter: Intl.DateTimeFormat, utc: Date): WallClock {
  const w = wallPartsIn(formatter, utc);
  return `${w.year}-${two(w.month)}-${two(w.day)}T${two(w.hour)}:${two(w.minute)}`;
}

/**
 * The UTC instant at which the wall clock in `tz` reads `wall`.
 * A wall time that occurs twice (DST fall-back) resolves to its first
 * occurrence; one that never occurs (DST spring-forward gap) resolves to the
 * instant the clocks skipped to. Zones without DST, such as Asia/Kolkata,
 * settle on the first pass.
 */
export function toInstant({ wall, tz }: { wall: WallClock; tz: string }): Date {
  const match = WALL_CLOCK_PATTERN.exec(wall);
  if (!match || !isWallClock(wall)) {
    throw new RangeError(`Invalid wall-clock value "${wall}" (expected YYYY-MM-DDTHH:mm)`);
  }
  const formatter = requireFormatter(tz);
  const asUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  const first = new Date(asUtc - offsetAt(formatter, new Date(asUtc)));
  if (wallOf(formatter, first) === wall) return first;
  const second = new Date(asUtc - offsetAt(formatter, first));
  if (wallOf(formatter, second) === wall) return second;
  return first.getTime() > second.getTime() ? first : second;
}

/** The wall clock (`YYYY-MM-DDTHH:mm`) shown in `tz` at the instant `utc`. */
export function fromInstant(utc: Date, tz: string): WallClock {
  const formatter = requireFormatter(tz);
  if (Number.isNaN(utc.getTime())) throw new RangeError('Invalid date');
  return wallOf(formatter, utc);
}

/** The calendar date (`YYYY-MM-DD`) in `tz` at the instant `utc`. */
export function localDateOf(utc: Date, tz: string): CalendarDate {
  return fromInstant(utc, tz).slice(0, 10);
}

/** The instant at which `date` begins (00:00) in `tz`. */
export function midnightOf(date: CalendarDate, tz: string): Date {
  if (!isCalendarDate(date)) throw new RangeError(`Invalid calendar date "${date}" (expected YYYY-MM-DD)`);
  return toInstant({ wall: `${date}T00:00`, tz });
}

/** Builds the stored `{ wall, utc }` pair for a wall-clock entry. */
export function windowEdge(wall: WallClock, tz: string): WindowEdge {
  return { wall, utc: toInstant({ wall, tz }) };
}

export type WindowProblemCode = 'EMPTY_WINDOW' | 'OVERLAP' | 'ORDER' | 'IN_THE_PAST';

export interface WindowProblem {
  /** Which field the UI should highlight. */
  path: 'sampling' | 'assessment' | 'sampling.end' | 'assessment.start' | 'assessment.end';
  code: WindowProblemCode;
  message: string;
}

export interface WindowsInput {
  sampling: { start: InstantLike; end: InstantLike };
  assessment: { start: InstantLike; end: InstantLike };
}

export interface ValidateWindowsOptions {
  /**
   * `settings`-driven relaxation: when true the assessment may start while
   * sampling is still open (it must still start no earlier than sampling and
   * end after sampling ends). Default false: `assessment.start ≥ sampling.end`.
   */
  allowSamplingOverlap?: boolean;
  /** When given (publish time), sampling must not already be over. */
  now?: Date;
}

export interface WindowsValidation {
  ok: boolean;
  problems: WindowProblem[];
}

/**
 * Ordering rules: `sampling.start < sampling.end ≤ assessment.start < assessment.end`.
 * Every violated rule is reported, so the UI can highlight all of them at once.
 */
export function validateWindows(windows: WindowsInput, options: ValidateWindowsOptions = {}): WindowsValidation {
  const samplingStart = instantOf(windows.sampling.start).getTime();
  const samplingEnd = instantOf(windows.sampling.end).getTime();
  const assessmentStart = instantOf(windows.assessment.start).getTime();
  const assessmentEnd = instantOf(windows.assessment.end).getTime();
  const problems: WindowProblem[] = [];

  if (!(samplingStart < samplingEnd)) {
    problems.push({ path: 'sampling', code: 'EMPTY_WINDOW', message: 'Sampling must end after it starts' });
  }
  if (!(assessmentStart < assessmentEnd)) {
    problems.push({ path: 'assessment', code: 'EMPTY_WINDOW', message: 'Assessment must end after it starts' });
  }

  if (options.allowSamplingOverlap === true) {
    if (assessmentStart < samplingStart) {
      problems.push({
        path: 'assessment.start',
        code: 'ORDER',
        message: 'Assessment cannot start before sampling starts',
      });
    }
    if (assessmentEnd <= samplingEnd) {
      problems.push({ path: 'assessment.end', code: 'ORDER', message: 'Assessment must end after sampling ends' });
    }
  } else if (assessmentStart < samplingEnd) {
    problems.push({
      path: 'assessment.start',
      code: 'OVERLAP',
      message: 'Assessment cannot start before sampling has ended',
    });
  }

  if (options.now !== undefined && samplingEnd <= options.now.getTime()) {
    problems.push({ path: 'sampling.end', code: 'IN_THE_PAST', message: 'Sampling has already ended' });
  }

  return { ok: problems.length === 0, problems };
}
