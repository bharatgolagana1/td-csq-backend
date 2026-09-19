import { describe, expect, it } from 'vitest';
import type { CycleWindows } from '@csq/core';
import {
  automaticBoundaries,
  clockSatisfied,
  isTerminal,
  legalTransitionsFrom,
  nextAutomaticTransition,
  nextScheduledEdge,
  planCatchUp,
  transitionSpec,
  windowStatus,
  CYCLE_TRANSITIONS,
  TRANSITIONS,
} from '../src/modules/cycles/cycles.state.js';
import { CYCLE_STATES } from '../src/modules/cycles/cycles.contracts.js';
import { resolveBoundary } from '../src/modules/cycles/cycles.time.js';

const tz = 'Asia/Kolkata';

function windows(overlap = false): CycleWindows {
  return {
    samplingOpens: resolveBoundary({ wall: '2026-04-01T00:00', tz }),
    samplingCloses: resolveBoundary({ wall: overlap ? '2026-05-15T00:00' : '2026-04-30T00:00', tz }),
    assessmentOpens: resolveBoundary({ wall: '2026-05-01T00:00', tz }),
    assessmentCloses: resolveBoundary({ wall: '2026-05-31T00:00', tz }),
  };
}

const at = (iso: string): Date => new Date(iso);

describe('the cycle state machine', () => {
  it('declares an edge for every transition and nothing else', () => {
    expect(TRANSITIONS.map((t) => t.name).sort()).toEqual([...CYCLE_TRANSITIONS].sort());
    for (const spec of TRANSITIONS) {
      expect(CYCLE_STATES).toContain(spec.from);
      expect(CYCLE_STATES).toContain(spec.to);
      expect(spec.capability).toMatch(/^cycles(\.[a-z-]+)?:[a-z]+$/);
    }
  });

  it('ends at PUBLISHED and nowhere else', () => {
    const terminal = CYCLE_STATES.filter(isTerminal);
    expect(terminal).toEqual(['PUBLISHED']);
  });

  it('has no edge that opens a window before its instant', () => {
    const w = windows();
    const justBefore = at('2026-03-31T18:29:59Z');

    expect(nextAutomaticTransition('SCHEDULED', w, justBefore)).toBeNull();
    expect(planCatchUp('SCHEDULED', w, justBefore)).toEqual([]);

    // one second later the clock has reached it and not before
    expect(nextAutomaticTransition('SCHEDULED', w, at('2026-03-31T18:30:00Z'))?.name).toBe(
      'OPEN_SAMPLING',
    );
  });

  it('catches up through every edge the clock has already passed', () => {
    const plan = planCatchUp('SCHEDULED', windows(), at('2026-06-01T00:00:00Z'));
    expect(plan.map((p) => p.name)).toEqual(['OPEN_SAMPLING', 'OPEN_ASSESSMENT', 'CLOSE']);
  });

  it('stops at the edge the clock has reached and no further', () => {
    const plan = planCatchUp('SCHEDULED', windows(), at('2026-05-02T00:00:00Z'));
    expect(plan.map((p) => p.name)).toEqual(['OPEN_SAMPLING', 'OPEN_ASSESSMENT']);
  });

  it('never advances a cycle that has not been scheduled', () => {
    expect(planCatchUp('DRAFT', windows(), at('2026-06-01T00:00:00Z'))).toEqual([]);
  });

  it('reports sampling and assessment as open at the same time when they overlap', () => {
    // an explicit requirement: late added customers are sampled after the
    // assessment window has already opened
    const status = windowStatus(windows(true), 'ASSESSMENT_OPEN', at('2026-05-05T00:00:00Z'));
    expect(status).toEqual({ samplingOpen: true, assessmentOpen: true });
  });

  it('reports nothing open before the cycle has started or after it has closed', () => {
    const w = windows();
    expect(windowStatus(w, 'DRAFT', at('2026-05-05T00:00:00Z'))).toEqual({
      samplingOpen: false,
      assessmentOpen: false,
    });
    expect(windowStatus(w, 'SCORED', at('2026-05-05T00:00:00Z'))).toEqual({
      samplingOpen: false,
      assessmentOpen: false,
    });
  });

  it('refuses to unschedule once sampling has opened', () => {
    const w = windows();
    const unschedule = transitionSpec('UNSCHEDULE');
    expect(clockSatisfied(unschedule.clock, w, at('2026-03-01T00:00:00Z'))).toBe(true);
    expect(clockSatisfied(unschedule.clock, w, at('2026-04-02T00:00:00Z'))).toBe(false);
  });

  it('names one task instant per clock driven edge', () => {
    const boundaries = automaticBoundaries('SCHEDULED', windows());
    expect(boundaries.map((b) => b.name)).toEqual(['OPEN_SAMPLING', 'OPEN_ASSESSMENT', 'CLOSE']);
    expect(boundaries.map((b) => b.at.toISOString())).toEqual([
      '2026-03-31T18:30:00.000Z',
      '2026-04-30T18:30:00.000Z',
      '2026-05-30T18:30:00.000Z',
    ]);
  });

  it('answers what happens next from any state', () => {
    expect(nextScheduledEdge('SCHEDULED', windows())?.name).toBe('OPEN_SAMPLING');
    expect(nextScheduledEdge('CLOSED', windows())).toBeNull();
    expect(nextScheduledEdge('PUBLISHED', windows())).toBeNull();
  });

  it('gives scoring and publishing different authorities from running a cycle', () => {
    const capabilities = new Set(TRANSITIONS.map((t) => t.capability));
    expect(capabilities.size).toBeGreaterThan(1);
    expect(transitionSpec('SCORE').capability).not.toBe(transitionSpec('PUBLISH').capability);
    expect(transitionSpec('OPEN_SAMPLING').capability).not.toBe(transitionSpec('SCHEDULE').capability);
  });

  it('records what freezes on every edge that freezes something', () => {
    for (const spec of TRANSITIONS) {
      expect(spec.freezes.length).toBeGreaterThan(10);
    }
    expect(transitionSpec('SCHEDULE').freeze).toBe('configurationFrozenAt');
    expect(transitionSpec('UNSCHEDULE').clears).toEqual(['configurationFrozenAt']);
  });

  it('leaves exactly one way out of each non terminal state for a person', () => {
    for (const state of CYCLE_STATES) {
      if (isTerminal(state)) continue;
      expect(legalTransitionsFrom(state).length).toBeGreaterThan(0);
    }
  });
});
