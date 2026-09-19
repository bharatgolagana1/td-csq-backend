import { describe, expect, it } from 'vitest';
import {
  isAmbiguous,
  isKnownZone,
  normaliseWall,
  resolveBoundary,
  zoneOffsetMs,
} from '../src/modules/cycles/cycles.time.js';

/**
 * These are the cases that make the {wall, tz, utc} triple worth storing. Each
 * one is a different instant for the same typed string, and getting any of them
 * wrong opens or closes a cycle at the wrong moment for a whole region.
 */
describe('wall time resolution', () => {
  it('reads midnight in the zone it was typed in', () => {
    const kolkata = resolveBoundary({ wall: '2026-04-12T00:00', tz: 'Asia/Kolkata' });
    const newYork = resolveBoundary({ wall: '2026-04-12T00:00', tz: 'America/New_York' });

    expect(kolkata.utc.toISOString()).toBe('2026-04-11T18:30:00.000Z');
    expect(newYork.utc.toISOString()).toBe('2026-04-12T04:00:00.000Z');
    // the same typed string, nine and a half hours apart
    expect(newYork.utc.getTime() - kolkata.utc.getTime()).toBe(9.5 * 3600 * 1000);
  });

  it('keeps the wall time and the zone alongside the instant', () => {
    const boundary = resolveBoundary({ wall: '2026-04-12T09:30', tz: 'Asia/Kolkata' });
    expect(boundary.wall).toBe('2026-04-12T09:30:00');
    expect(boundary.tz).toBe('Asia/Kolkata');
  });

  it('refuses a local time the clocks skip over', () => {
    // 02:30 on 2026-03-08 never happens in New York: 02:00 becomes 03:00
    expect(() => resolveBoundary({ wall: '2026-03-08T02:30', tz: 'America/New_York' })).toThrowError(
      /does not exist/,
    );
  });

  it('takes the first of two instants when the clocks go back over one', () => {
    const input = { wall: '2026-11-01T01:30', tz: 'America/New_York' };
    expect(isAmbiguous(input)).toBe(true);
    // 05:30Z is the daylight saving occurrence, 06:30Z the standard one
    expect(resolveBoundary(input).utc.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('is unambiguous in a zone with no daylight saving', () => {
    expect(isAmbiguous({ wall: '2026-11-01T01:30', tz: 'Asia/Kolkata' })).toBe(false);
  });

  it('refuses a date that is not on the calendar', () => {
    expect(() => resolveBoundary({ wall: '2026-02-30T00:00', tz: 'Asia/Kolkata' })).toThrowError(
      /not a real date/,
    );
    expect(() => resolveBoundary({ wall: '2026-13-01T00:00', tz: 'Asia/Kolkata' })).toThrowError();
  });

  it('accepts a leap day that exists', () => {
    expect(resolveBoundary({ wall: '2028-02-29T12:00', tz: 'Asia/Kolkata' }).utc.toISOString()).toBe(
      '2028-02-29T06:30:00.000Z',
    );
  });

  it('refuses a zone the tz database does not know', () => {
    expect(isKnownZone('Mars/Phobos')).toBe(false);
    expect(isKnownZone('Asia/Kolkata')).toBe(true);
    expect(() => resolveBoundary({ wall: '2026-04-12T00:00', tz: 'Mars/Phobos' })).toThrowError(
      /not a time zone/,
    );
  });

  it('reports the offset that actually applied on the day', () => {
    // the same zone, two different offsets, five months apart
    expect(zoneOffsetMs('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-5 * 3600 * 1000);
    expect(zoneOffsetMs('America/New_York', new Date('2026-06-15T12:00:00Z'))).toBe(-4 * 3600 * 1000);
    expect(zoneOffsetMs('Asia/Kolkata', new Date('2026-06-15T12:00:00Z'))).toBe(5.5 * 3600 * 1000);
  });

  it('normalises seconds so two spellings of one instant are one string', () => {
    expect(normaliseWall('2026-04-12T00:00')).toBe('2026-04-12T00:00:00');
    expect(normaliseWall('2026-04-12T00:00:00')).toBe('2026-04-12T00:00:00');
  });
});
