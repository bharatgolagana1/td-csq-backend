import { describe, expect, it } from 'vitest';

import {
  addCalendarDays,
  deriveReminderSchedule,
  deriveWindows,
  nextReminder,
} from '../../../src/modules/cycles/domain/derive.js';
import { validateWindows } from '../../../src/modules/cycles/domain/windows.js';

const IST = 'Asia/Kolkata';
const defaults = { samplingDays: 10, assessmentDays: 30 };

describe('addCalendarDays', () => {
  it('handles leap years and month/year rollover', () => {
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addCalendarDays('2026-12-25', 10)).toBe('2027-01-04');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('rejects bad input', () => {
    expect(() => addCalendarDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addCalendarDays('2026-02-01', 1.5)).toThrow(RangeError);
  });
});

describe('deriveWindows', () => {
  it('follows the 2017 product: sampling from initiation 00:00, assessment starts when sampling ends', () => {
    const windows = deriveWindows({ initiationDate: '2026-11-01', tz: IST, defaults });
    expect(windows.sampling.start).toEqual({ wall: '2026-11-01T00:00', utc: new Date('2026-10-31T18:30:00Z') });
    expect(windows.sampling.end).toEqual({ wall: '2026-11-11T00:00', utc: new Date('2026-11-10T18:30:00Z') });
    expect(windows.assessment.start).toEqual(windows.sampling.end);
    expect(windows.assessment.end).toEqual({ wall: '2026-12-11T00:00', utc: new Date('2026-12-10T18:30:00Z') });
  });

  it('produces windows that pass validateWindows', () => {
    const windows = deriveWindows({ initiationDate: '2026-12-25', tz: IST, defaults });
    expect(validateWindows(windows).ok).toBe(true);
    expect(windows.assessment.end.wall).toBe('2027-02-03T00:00');
  });

  it('rejects an invalid initiation date or non-positive defaults', () => {
    expect(() => deriveWindows({ initiationDate: '01/11/2026', tz: IST, defaults })).toThrow(RangeError);
    expect(() => deriveWindows({ initiationDate: '2026-11-01', tz: IST, defaults: { samplingDays: 0, assessmentDays: 30 } })).toThrow(/samplingDays/);
    expect(() => deriveWindows({ initiationDate: '2026-11-01', tz: IST, defaults: { samplingDays: 10, assessmentDays: 2.5 } })).toThrow(/assessmentDays/);
    expect(() => deriveWindows({ initiationDate: '2026-11-01', tz: 'Not/AZone', defaults })).toThrow(/time zone/);
  });
});

describe('deriveReminderSchedule', () => {
  const sampling = deriveWindows({ initiationDate: '2026-11-01', tz: IST, defaults }).sampling;

  it('fires every everyDays after the start at 09:00 local', () => {
    const schedule = deriveReminderSchedule(sampling, { count: 3, everyDays: 3 }, { tz: IST });
    expect(schedule).toEqual(['2026-11-04T03:30:00.000Z', '2026-11-07T03:30:00.000Z', '2026-11-10T03:30:00.000Z']);
  });

  it('is clipped to the window: reminders at or after the end are dropped', () => {
    expect(deriveReminderSchedule(sampling, { count: 10, everyDays: 3 }, { tz: IST })).toHaveLength(3);
    const endsAtNine = { start: sampling.start, end: new Date('2026-11-04T03:30:00Z') };
    expect(deriveReminderSchedule(endsAtNine, { count: 3, everyDays: 3 }, { tz: IST })).toEqual([]);
    const endsAtNineOhOne = { start: sampling.start, end: new Date('2026-11-04T03:31:00Z') };
    expect(deriveReminderSchedule(endsAtNineOhOne, { count: 3, everyDays: 3 }, { tz: IST })).toHaveLength(1);
  });

  it('never schedules before the publish instant', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    expect(deriveReminderSchedule(sampling, { count: 3, everyDays: 3 }, { tz: IST, now })).toEqual([
      '2026-11-07T03:30:00.000Z',
      '2026-11-10T03:30:00.000Z',
    ]);
    const exactlyAtFirst = new Date('2026-11-04T03:30:00Z');
    expect(deriveReminderSchedule(sampling, { count: 3, everyDays: 3 }, { tz: IST, now: exactlyAtFirst })).toHaveLength(3);
  });

  it('respects the assessment defaults (10 reminders every 2 days inside 30 days)', () => {
    const assessment = deriveWindows({ initiationDate: '2026-11-01', tz: IST, defaults }).assessment;
    const schedule = deriveReminderSchedule(assessment, { count: 10, everyDays: 2 }, { tz: IST });
    expect(schedule).toHaveLength(10);
    expect(schedule[0]).toBe('2026-11-13T03:30:00.000Z');
    expect(schedule[9]).toBe('2026-12-01T03:30:00.000Z');
  });

  it('honours a different local hour and a count of zero', () => {
    expect(deriveReminderSchedule(sampling, { count: 1, everyDays: 1 }, { tz: IST, hourLocal: 18 })).toEqual([
      '2026-11-02T12:30:00.000Z',
    ]);
    expect(deriveReminderSchedule(sampling, { count: 0, everyDays: 3 }, { tz: IST })).toEqual([]);
  });

  it('rejects an invalid policy', () => {
    expect(() => deriveReminderSchedule(sampling, { count: 3, everyDays: 0 }, { tz: IST })).toThrow(/everyDays/);
    expect(() => deriveReminderSchedule(sampling, { count: -1, everyDays: 1 }, { tz: IST })).toThrow(/count/);
    expect(() => deriveReminderSchedule(sampling, { count: 1, everyDays: 1 }, { tz: IST, hourLocal: 24 })).toThrow(/hourLocal/);
  });
});

describe('nextReminder', () => {
  const schedule = ['2026-11-04T03:30:00.000Z', '2026-11-07T03:30:00.000Z'];

  it('returns the first unsent reminder with its due flag', () => {
    expect(nextReminder(schedule, 0, new Date('2026-11-03T00:00:00Z'))).toEqual({ index: 0, at: schedule[0], due: false });
    expect(nextReminder(schedule, 0, new Date('2026-11-04T03:30:00Z'))).toEqual({ index: 0, at: schedule[0], due: true });
    expect(nextReminder(schedule, 1, new Date('2026-11-06T00:00:00Z'))).toEqual({ index: 1, at: schedule[1], due: false });
  });

  it('is null once every reminder went out', () => {
    expect(nextReminder(schedule, 2, new Date('2026-12-01T00:00:00Z'))).toBeNull();
    expect(nextReminder([], 0, new Date())).toBeNull();
  });

  it('rejects a negative sent count', () => {
    expect(() => nextReminder(schedule, -1, new Date())).toThrow(RangeError);
  });
});
