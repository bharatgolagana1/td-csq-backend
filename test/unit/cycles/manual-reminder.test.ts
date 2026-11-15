import { describe, expect, it } from 'vitest';

import { coveredByManualReminder } from '../../../src/modules/cycles/reminders.service.js';

/* "Send sampling reminders" by hand, then the scheduled reminder falls due:
   the operator must not get the same mail twice. */

const DUE = '2026-11-20T03:30:00.000Z';
const HOUR = 60 * 60 * 1000;
const dueMs = new Date(DUE).getTime();

describe('coveredByManualReminder', () => {
  it('a reminder sent by hand since the scheduled one fell due covers it', () => {
    expect(coveredByManualReminder(new Date(dueMs + 30_000), DUE)).toBe(true);
  });

  it('so does one sent by hand in the 12 hours before', () => {
    expect(coveredByManualReminder(new Date(dueMs - 30_000), DUE)).toBe(true);
    expect(coveredByManualReminder(new Date(dueMs - 12 * HOUR), DUE)).toBe(true);
  });

  it('an older one, or none, does not', () => {
    expect(coveredByManualReminder(new Date(dueMs - 12 * HOUR - 1), DUE)).toBe(false);
    expect(coveredByManualReminder(new Date(dueMs - 3 * 24 * HOUR), DUE)).toBe(false);
    expect(coveredByManualReminder(null, DUE)).toBe(false);
    expect(coveredByManualReminder(undefined, DUE)).toBe(false);
  });
});
