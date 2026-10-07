import { describe, expect, it } from 'vitest';

import { deriveWindows } from '../../../src/modules/cycles/domain/derive.js';
import {
  TRANSITION_TABLE,
  allowedTransitions,
  canManuallyTransition,
  checkManualTransition,
  dueTransition,
  dueTransitions,
  isTerminalStatus,
  statusAfterPublish,
  type CycleClock,
} from '../../../src/modules/cycles/domain/transitions.js';
import { CYCLE_STATUSES, type CycleStatus } from '../../../src/modules/cycles/domain/types.js';

const IST = 'Asia/Kolkata';
const windows = deriveWindows({ initiationDate: '2026-11-01', tz: IST, defaults: { samplingDays: 10, assessmentDays: 30 } });
// sampling 2026-10-31T18:30Z → 2026-11-10T18:30Z; assessment 2026-11-10T18:30Z → 2026-12-10T18:30Z
const cycle = (status: CycleStatus): CycleClock => ({ status, ...windows });
const at = (iso: string): Date => new Date(iso);

describe('guard table', () => {
  it('covers every status exactly as documented', () => {
    expect(allowedTransitions('DRAFT')).toEqual(['PUBLISHED', 'SAMPLING_OPEN']);
    expect(allowedTransitions('PUBLISHED')).toEqual(['SAMPLING_OPEN']);
    expect(allowedTransitions('SAMPLING_OPEN')).toEqual(['SAMPLING_CLOSED']);
    expect(allowedTransitions('SAMPLING_CLOSED')).toEqual(['SAMPLING_OPEN', 'ASSESSMENT_OPEN']);
    expect(allowedTransitions('ASSESSMENT_OPEN')).toEqual(['ASSESSMENT_CLOSED']);
    expect(allowedTransitions('ASSESSMENT_CLOSED')).toEqual(['ASSESSMENT_OPEN', 'SCORED']);
    expect(allowedTransitions('SCORED')).toEqual(['ARCHIVED']);
    expect(allowedTransitions('ARCHIVED')).toEqual([]);
  });

  it('only ARCHIVED is terminal, and every table entry names real statuses', () => {
    expect(CYCLE_STATUSES.filter(isTerminalStatus)).toEqual(['ARCHIVED']);
    for (const rule of TRANSITION_TABLE) {
      expect(CYCLE_STATUSES).toContain(rule.from);
      expect(CYCLE_STATUSES).toContain(rule.to);
      expect(rule.via.length).toBeGreaterThan(0);
    }
  });
});

describe('canManuallyTransition', () => {
  it('lets an operator advance or re-open, never publish or skip', () => {
    expect(canManuallyTransition('DRAFT', 'PUBLISHED')).toBe(false);
    expect(canManuallyTransition('DRAFT', 'SAMPLING_OPEN')).toBe(false);
    expect(canManuallyTransition('PUBLISHED', 'SAMPLING_OPEN')).toBe(true);
    expect(canManuallyTransition('SAMPLING_OPEN', 'SAMPLING_CLOSED')).toBe(true);
    expect(canManuallyTransition('SAMPLING_OPEN', 'ASSESSMENT_OPEN')).toBe(false);
    expect(canManuallyTransition('SAMPLING_CLOSED', 'SAMPLING_OPEN')).toBe(true);
    expect(canManuallyTransition('SAMPLING_CLOSED', 'ASSESSMENT_OPEN')).toBe(true);
    expect(canManuallyTransition('ASSESSMENT_OPEN', 'ASSESSMENT_CLOSED')).toBe(true);
    expect(canManuallyTransition('ASSESSMENT_CLOSED', 'ASSESSMENT_OPEN')).toBe(true);
    expect(canManuallyTransition('ASSESSMENT_CLOSED', 'SCORED')).toBe(true);
    expect(canManuallyTransition('SCORED', 'ARCHIVED')).toBe(true);
    expect(canManuallyTransition('SCORED', 'ASSESSMENT_OPEN')).toBe(false);
    expect(canManuallyTransition('ARCHIVED', 'SCORED')).toBe(false);
    expect(canManuallyTransition('PUBLISHED', 'PUBLISHED')).toBe(false);
  });
});

describe('statusAfterPublish', () => {
  it('lands on SAMPLING_OPEN only once sampling has started', () => {
    expect(statusAfterPublish(windows, at('2026-10-31T18:29:59Z'))).toBe('PUBLISHED');
    expect(statusAfterPublish(windows, at('2026-10-31T18:30:00Z'))).toBe('SAMPLING_OPEN');
  });
});

describe('dueTransition (the scheduler clock)', () => {
  it('activates the assessment at Asia/Kolkata midnight, not a second earlier', () => {
    expect(dueTransition(cycle('SAMPLING_CLOSED'), at('2026-11-10T18:29:59Z'))).toBeNull();
    expect(dueTransition(cycle('SAMPLING_CLOSED'), at('2026-11-10T18:30:00Z'))).toEqual({
      from: 'SAMPLING_CLOSED',
      to: 'ASSESSMENT_OPEN',
      trigger: 'ASSESSMENT_START',
      at: windows.assessment.start.utc,
    });
  });

  it('opens sampling at sampling.start and closes it at sampling.end', () => {
    expect(dueTransition(cycle('PUBLISHED'), at('2026-10-30T00:00:00Z'))).toBeNull();
    expect(dueTransition(cycle('PUBLISHED'), at('2026-10-31T18:30:00Z'))?.to).toBe('SAMPLING_OPEN');
    expect(dueTransition(cycle('SAMPLING_OPEN'), at('2026-11-05T00:00:00Z'))).toBeNull();
    expect(dueTransition(cycle('SAMPLING_OPEN'), at('2026-11-10T18:30:00Z'))).toMatchObject({
      to: 'SAMPLING_CLOSED',
      trigger: 'SAMPLING_END',
    });
  });

  it('closes the assessment at assessment.end and then asks for scoring', () => {
    expect(dueTransition(cycle('ASSESSMENT_OPEN'), at('2026-12-10T18:29:59Z'))).toBeNull();
    expect(dueTransition(cycle('ASSESSMENT_OPEN'), at('2026-12-10T18:30:00Z'))).toMatchObject({
      to: 'ASSESSMENT_CLOSED',
      trigger: 'ASSESSMENT_END',
    });
    expect(dueTransition(cycle('ASSESSMENT_CLOSED'), at('2026-12-10T18:30:00Z'))).toEqual({
      from: 'ASSESSMENT_CLOSED',
      to: 'SCORED',
      trigger: 'SCORING',
      at: windows.assessment.end.utc,
    });
  });

  it('never moves DRAFT, SCORED or ARCHIVED cycles', () => {
    const late = at('2030-01-01T00:00:00Z');
    expect(dueTransition(cycle('DRAFT'), late)).toBeNull();
    expect(dueTransition(cycle('SCORED'), late)).toBeNull();
    expect(dueTransition(cycle('ARCHIVED'), late)).toBeNull();
  });

  it('advances one step per call; dueTransitions shows the catch-up chain', () => {
    const late = at('2026-12-31T00:00:00Z');
    expect(dueTransition(cycle('PUBLISHED'), late)?.to).toBe('SAMPLING_OPEN');
    expect(dueTransitions(cycle('PUBLISHED'), late).map((step) => step.to)).toEqual([
      'SAMPLING_OPEN',
      'SAMPLING_CLOSED',
      'ASSESSMENT_OPEN',
      'ASSESSMENT_CLOSED',
      'SCORED',
    ]);
    expect(dueTransitions(cycle('PUBLISHED'), at('2026-11-05T00:00:00Z')).map((step) => step.to)).toEqual(['SAMPLING_OPEN']);
    expect(dueTransitions(cycle('SCORED'), late)).toEqual([]);
  });
});

describe('checkManualTransition', () => {
  it('refuses edges outside the table', () => {
    const result = checkManualTransition(cycle('DRAFT'), 'SAMPLING_OPEN', at('2026-11-01T00:00:00Z'));
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.code).toBe('NOT_ALLOWED');
  });

  it('allows an early close and an early open', () => {
    expect(checkManualTransition(cycle('SAMPLING_OPEN'), 'SAMPLING_CLOSED', at('2026-11-05T00:00:00Z')).ok).toBe(true);
    expect(checkManualTransition(cycle('PUBLISHED'), 'SAMPLING_OPEN', at('2026-10-01T00:00:00Z')).ok).toBe(true);
    expect(checkManualTransition(cycle('SAMPLING_CLOSED'), 'ASSESSMENT_OPEN', at('2026-11-06T00:00:00Z')).ok).toBe(true);
  });

  it('refuses re-opening a window the clock has already closed', () => {
    const reopenLate = checkManualTransition(cycle('SAMPLING_CLOSED'), 'SAMPLING_OPEN', at('2026-11-10T18:30:00Z'));
    expect(reopenLate.ok).toBe(false);
    expect(reopenLate.problems[0]?.code).toBe('WINDOW_ALREADY_ENDED');

    const reopenEarly = checkManualTransition(cycle('SAMPLING_CLOSED'), 'SAMPLING_OPEN', at('2026-11-08T00:00:00Z'));
    expect(reopenEarly.ok).toBe(true);

    const reopenAssessment = checkManualTransition(cycle('ASSESSMENT_CLOSED'), 'ASSESSMENT_OPEN', at('2026-12-20T00:00:00Z'));
    expect(reopenAssessment.problems.map((p) => p.code)).toEqual(['WINDOW_ALREADY_ENDED']);
  });
});
