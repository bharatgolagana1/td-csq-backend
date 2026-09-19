import { fail } from '../../kernel/errors.js';
import type { CycleBoundary } from '@csq/core';
import type { BoundaryInput, BoundaryView } from './cycles.contracts.js';

/**
 * Wall time to instant, resolved against the platform tz database.
 *
 * An administrator types "midnight on the 12th". That is not an instant until
 * it is paired with a zone, and the pair is what gets stored, because the two
 * of them together are the only record of what the administrator actually meant.
 * Storing the instant alone loses the intent; storing the wall time alone loses
 * the answer. A cycle that opens an hour early because a server moved region is
 * not recoverable once invitations are out.
 *
 * No dependency is added for this. Node 20 ships full ICU, and Intl is the same
 * tz database a date library would wrap.
 */

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws VALIDATION_FAILED for a zone this platform's tz database does not know. */
export function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz);
  if (cached) return cached;

  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat('en-US', {
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
    throw fail('VALIDATION_FAILED', `${tz} is not a time zone this system knows`, [
      { path: 'tz', message: 'must be an IANA zone, for example Asia/Kolkata' },
    ]);
  }
  formatters.set(tz, made);
  return made;
}

export function isKnownZone(tz: string): boolean {
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(tz: string, instant: Date): WallParts {
  const parts = formatterFor(tz).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw fail('INTERNAL', `Intl did not return a ${type} part for ${tz}`);
    return Number(found.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function asUtcMs(p: WallParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Zone offset in milliseconds at a given instant: local wall time minus UTC. */
export function zoneOffsetMs(tz: string, instant: Date): number {
  return asUtcMs(partsIn(tz, instant)) - instant.getTime();
}

function parseWall(wall: string): WallParts {
  const m = WALL.exec(wall);
  if (!m) {
    throw fail('VALIDATION_FAILED', `${wall} is not a local date and time`, [
      { path: 'wall', message: 'expected YYYY-MM-DDTHH:mm, for example 2026-04-12T00:00' },
    ]);
  }
  const parts: WallParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] === undefined ? 0 : Number(m[6]),
  };

  // 2026-02-30 matches the pattern and is not a date. Date.UTC rolls it over
  // silently, so the round trip is the check.
  const rolled = new Date(asUtcMs(parts));
  if (
    rolled.getUTCFullYear() !== parts.year ||
    rolled.getUTCMonth() + 1 !== parts.month ||
    rolled.getUTCDate() !== parts.day ||
    rolled.getUTCHours() !== parts.hour ||
    rolled.getUTCMinutes() !== parts.minute ||
    rolled.getUTCSeconds() !== parts.second
  ) {
    throw fail('VALIDATION_FAILED', `${wall} is not a real date and time`, [
      { path: 'wall', message: 'no such calendar date' },
    ]);
  }
  return parts;
}

export function normaliseWall(wall: string): string {
  const p = parseWall(wall);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

function sameWall(a: WallParts, b: WallParts): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

const DAY_MS = 86_400_000;

/**
 * Every instant that renders as this wall time in this zone.
 *
 * The offset that applies is the thing being solved for, so the candidates are
 * built from the offsets in force a day either side of the naive instant, which
 * brackets any daylight saving change near it. A normal wall time yields one
 * candidate. A wall time the clocks skip yields none. One the clocks repeat
 * yields two, which is the only honest answer.
 */
function candidateInstants(wall: WallParts, tz: string): number[] {
  const naive = asUtcMs(wall);
  const offsets = [
    zoneOffsetMs(tz, new Date(naive - DAY_MS)),
    zoneOffsetMs(tz, new Date(naive)),
    zoneOffsetMs(tz, new Date(naive + DAY_MS)),
  ];

  const found: number[] = [];
  for (const offset of offsets) {
    const candidate = naive - offset;
    if (found.includes(candidate)) continue;
    if (sameWall(partsIn(tz, new Date(candidate)), wall)) found.push(candidate);
  }
  return found.sort((a, b) => a - b);
}

/**
 * Resolves a wall time in a zone to the instant it names.
 *
 * A wall time inside a spring-forward gap names no instant and is refused
 * rather than quietly moved, because "02:30 does not exist on that date here"
 * is something the administrator must see before invitations go out. An
 * ambiguous autumn wall time names two and takes the earlier, deterministically.
 */
export function resolveBoundary(input: BoundaryInput): CycleBoundary {
  const wantedWall = normaliseWall(input.wall);
  const wanted = parseWall(wantedWall);
  formatterFor(input.tz);

  const earliest = candidateInstants(wanted, input.tz)[0];
  if (earliest === undefined) {
    throw fail(
      'VALIDATION_FAILED',
      `${wantedWall} does not exist in ${input.tz}: the clocks move forward over it`,
      [{ path: 'wall', message: 'local time skipped by a daylight saving change' }],
    );
  }

  return { wall: wantedWall, tz: input.tz, utc: new Date(earliest) };
}

/** True when the same wall time names two instants, as it does when clocks go back. */
export function isAmbiguous(input: BoundaryInput): boolean {
  return candidateInstants(parseWall(normaliseWall(input.wall)), input.tz).length > 1;
}

export function boundaryView(boundary: CycleBoundary): BoundaryView {
  return { wall: boundary.wall, tz: boundary.tz, utc: boundary.utc.toISOString() };
}
