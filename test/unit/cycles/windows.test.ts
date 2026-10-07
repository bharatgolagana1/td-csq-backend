import { describe, expect, it } from 'vitest';

import {
  fromInstant,
  isCalendarDate,
  isValidTimeZone,
  isWallClock,
  localDateOf,
  midnightOf,
  toInstant,
  validateWindows,
  windowEdge,
} from '../../../src/modules/cycles/domain/windows.js';

const IST = 'Asia/Kolkata';
const HOUR = 3_600_000;

describe('toInstant / fromInstant', () => {
  it('maps Asia/Kolkata midnight to 18:30Z the previous day', () => {
    expect(toInstant({ wall: '2026-11-01T00:00', tz: IST }).toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });

  it('is the identity for UTC', () => {
    expect(toInstant({ wall: '2026-11-01T00:00', tz: 'UTC' }).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('round-trips through fromInstant', () => {
    const wall = '2026-03-15T09:30';
    expect(fromInstant(toInstant({ wall, tz: IST }), IST)).toBe(wall);
  });

  it('shows 23:59 in Kolkata one minute before its midnight', () => {
    expect(fromInstant(new Date('2026-10-31T18:29:00Z'), IST)).toBe('2026-10-31T23:59');
    expect(fromInstant(new Date('2026-10-31T18:30:00Z'), IST)).toBe('2026-11-01T00:00');
  });

  it('localDateOf follows the zone, not UTC', () => {
    expect(localDateOf(new Date('2026-10-31T18:30:00Z'), IST)).toBe('2026-11-01');
    expect(localDateOf(new Date('2026-10-31T18:30:00Z'), 'UTC')).toBe('2026-10-31');
  });

  it('Asia/Kolkata has no DST: the offset is +05:30 in January and July alike', () => {
    const offsetIn = (wall: string): number =>
      (Date.parse(`${wall}:00Z`) - toInstant({ wall, tz: IST }).getTime()) / HOUR;
    expect(offsetIn('2026-01-15T12:00')).toBe(5.5);
    expect(offsetIn('2026-07-15T12:00')).toBe(5.5);
    expect(offsetIn('2026-10-25T02:30')).toBe(5.5);
  });

  it('a DST zone does shift, which shows the conversion really consults the zone', () => {
    expect(toInstant({ wall: '2026-01-15T12:00', tz: 'Europe/London' }).toISOString()).toBe('2026-01-15T12:00:00.000Z');
    expect(toInstant({ wall: '2026-07-15T12:00', tz: 'Europe/London' }).toISOString()).toBe('2026-07-15T11:00:00.000Z');
  });

  it('resolves DST edge cases deterministically: gap → skipped-to instant, overlap → first occurrence', () => {
    // New York springs forward 2026-03-08 at 02:00 EST → 03:00 EDT (07:00Z): 02:30 never happens.
    expect(toInstant({ wall: '2026-03-08T02:30', tz: 'America/New_York' }).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(toInstant({ wall: '2026-03-08T01:59', tz: 'America/New_York' }).toISOString()).toBe('2026-03-08T06:59:00.000Z');
    expect(toInstant({ wall: '2026-03-08T03:00', tz: 'America/New_York' }).toISOString()).toBe('2026-03-08T07:00:00.000Z');
    // Falls back 2026-11-01 at 02:00 EDT → 01:00 EST (06:00Z): 01:30 happens twice; the first is EDT.
    expect(toInstant({ wall: '2026-11-01T01:30', tz: 'America/New_York' }).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(toInstant({ wall: '2026-11-01T02:00', tz: 'America/New_York' }).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    // Midnight on the transition day in a DST zone is still a plain midnight.
    expect(fromInstant(toInstant({ wall: '2026-03-29T00:00', tz: 'Europe/London' }), 'Europe/London')).toBe('2026-03-29T00:00');
  });

  it('rejects malformed or impossible wall clocks', () => {
    expect(() => toInstant({ wall: '2026-11-01', tz: IST })).toThrow(RangeError);
    expect(() => toInstant({ wall: '2026-02-30T00:00', tz: IST })).toThrow(RangeError);
    expect(() => toInstant({ wall: '2026-11-01T24:00', tz: IST })).toThrow(RangeError);
    expect(() => toInstant({ wall: '2026-11-01T10:60', tz: IST })).toThrow(RangeError);
    expect(() => toInstant({ wall: '2026-11-01T00:00:00', tz: IST })).toThrow(RangeError);
  });

  it('rejects unknown time zones', () => {
    expect(() => toInstant({ wall: '2026-11-01T00:00', tz: 'Mars/Olympus' })).toThrow(/time zone/);
    expect(() => fromInstant(new Date(), '')).toThrow(RangeError);
    expect(isValidTimeZone(IST)).toBe(true);
    expect(isValidTimeZone('Nowhere/Land')).toBe(false);
  });
});

describe('midnightOf / windowEdge', () => {
  it('gives the first instant of the day in the zone', () => {
    expect(midnightOf('2026-11-01', IST).toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(() => midnightOf('2026-13-01', IST)).toThrow(RangeError);
  });

  it('windowEdge keeps the wall text and computes the instant', () => {
    expect(windowEdge('2026-11-01T00:00', IST)).toEqual({
      wall: '2026-11-01T00:00',
      utc: new Date('2026-10-31T18:30:00.000Z'),
    });
  });

  it('format guards', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2026-1-1')).toBe(false);
    expect(isWallClock('2026-11-01T23:59')).toBe(true);
    expect(isWallClock('2026-11-01 23:59')).toBe(false);
  });
});

describe('validateWindows', () => {
  const d = (iso: string): Date => new Date(iso);
  const good = {
    sampling: { start: d('2026-10-31T18:30:00Z'), end: d('2026-11-10T18:30:00Z') },
    assessment: { start: d('2026-11-10T18:30:00Z'), end: d('2026-12-10T18:30:00Z') },
  };

  it('accepts sampling.start < sampling.end = assessment.start < assessment.end', () => {
    expect(validateWindows(good)).toEqual({ ok: true, problems: [] });
  });

  it('accepts stored { wall, utc } edges as well as dates', () => {
    const windows = {
      sampling: { start: windowEdge('2026-11-01T00:00', IST), end: windowEdge('2026-11-11T00:00', IST) },
      assessment: { start: windowEdge('2026-11-11T00:00', IST), end: windowEdge('2026-12-11T00:00', IST) },
    };
    expect(validateWindows(windows).ok).toBe(true);
  });

  it('flags an empty or inverted window', () => {
    const result = validateWindows({ ...good, sampling: { start: good.sampling.end, end: good.sampling.start } });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('EMPTY_WINDOW');
    expect(result.problems[0]?.path).toBe('sampling');
  });

  it('flags a zero-length assessment', () => {
    const result = validateWindows({ ...good, assessment: { start: good.assessment.start, end: good.assessment.start } });
    expect(result.problems).toMatchObject([{ path: 'assessment', code: 'EMPTY_WINDOW' }]);
  });

  it('refuses the assessment starting before sampling ends by default', () => {
    const result = validateWindows({
      ...good,
      assessment: { start: d('2026-11-05T18:30:00Z'), end: good.assessment.end },
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toMatchObject([{ path: 'assessment.start', code: 'OVERLAP' }]);
  });

  it('allows the overlap when settings say so, but still demands sane ordering', () => {
    const overlapping = { ...good, assessment: { start: d('2026-11-05T18:30:00Z'), end: good.assessment.end } };
    expect(validateWindows(overlapping, { allowSamplingOverlap: true }).ok).toBe(true);

    const beforeSampling = { ...good, assessment: { start: d('2026-10-01T00:00:00Z'), end: good.assessment.end } };
    expect(validateWindows(beforeSampling, { allowSamplingOverlap: true }).problems.map((p) => p.code)).toEqual(['ORDER']);

    const endsInsideSampling = {
      ...good,
      assessment: { start: d('2026-11-02T00:00:00Z'), end: d('2026-11-05T00:00:00Z') },
    };
    const result = validateWindows(endsInsideSampling, { allowSamplingOverlap: true });
    expect(result.problems).toMatchObject([{ path: 'assessment.end', code: 'ORDER' }]);
  });

  it('reports every problem at once', () => {
    const result = validateWindows({
      sampling: { start: d('2026-11-10T00:00:00Z'), end: d('2026-11-01T00:00:00Z') },
      assessment: { start: d('2026-10-01T00:00:00Z'), end: d('2026-10-01T00:00:00Z') },
    });
    expect(result.problems.map((p) => p.code).sort()).toEqual(['EMPTY_WINDOW', 'EMPTY_WINDOW', 'OVERLAP']);
  });

  it('with now, refuses windows whose sampling is already over', () => {
    expect(validateWindows(good, { now: d('2026-11-10T18:30:00Z') }).problems).toMatchObject([
      { path: 'sampling.end', code: 'IN_THE_PAST' },
    ]);
    expect(validateWindows(good, { now: d('2026-11-10T18:29:59Z') }).ok).toBe(true);
  });
});
