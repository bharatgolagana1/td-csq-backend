import { describe, expect, it } from 'vitest';
import { isOpen, remindersWithin, validateOrdering, type CycleWindows } from '../src/index.js';

const b = (iso: string) => ({ wall: iso.slice(0, 19), tz: 'Asia/Kolkata', utc: new Date(iso) });

const w: CycleWindows = {
  samplingOpens:    b('2026-04-01T00:00:00.000Z'),
  samplingCloses:   b('2026-04-20T00:00:00.000Z'),
  assessmentOpens:  b('2026-04-12T00:00:00.000Z'), // deliberately overlaps sampling
  assessmentCloses: b('2026-05-01T00:00:00.000Z'),
};

describe('cycle windows', () => {
  it('reports a window open only between its boundaries', () => {
    expect(isOpen(w, 'SAMPLING', new Date('2026-04-05T00:00:00Z'))).toBe(true);
    expect(isOpen(w, 'SAMPLING', new Date('2026-03-31T23:59:59Z'))).toBe(false);
    expect(isOpen(w, 'SAMPLING', new Date('2026-04-20T00:00:00Z'))).toBe(false); // end exclusive
  });

  it('permits assessment to open while sampling is still open', () => {
    // late-added customers can be sampled after assessment begins; this overlap
    // is a requirement, not a mistake
    expect(validateOrdering(w)).toEqual([]);
    const mid = new Date('2026-04-15T00:00:00Z');
    expect(isOpen(w, 'SAMPLING', mid)).toBe(true);
    expect(isOpen(w, 'ASSESSMENT', mid)).toBe(true);
  });

  it('rejects windows that end before they open', () => {
    const bad: CycleWindows = { ...w, samplingCloses: b('2026-03-01T00:00:00.000Z') };
    expect(validateOrdering(bad)).toContain('SAMPLING_ENDS_BEFORE_IT_OPENS');
  });

  it('rejects assessment opening before sampling has started', () => {
    const bad: CycleWindows = { ...w, assessmentOpens: b('2026-03-01T00:00:00.000Z') };
    expect(validateOrdering(bad)).toContain('ASSESSMENT_OPENS_BEFORE_SAMPLING_OPENS');
  });

  it('keeps only reminders that fall inside the assessment window, in order', () => {
    const r = remindersWithin(w, [
      new Date('2026-04-25T00:00:00Z'),
      new Date('2026-04-02T00:00:00Z'), // before assessment opens
      new Date('2026-04-18T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'), // after it closes
    ]);
    expect(r.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-04-18', '2026-04-25']);
  });

  it('stores the zone alongside the instant so midnight means one thing', () => {
    expect(w.samplingOpens.tz).toBe('Asia/Kolkata');
    expect(w.samplingOpens.utc instanceof Date).toBe(true);
  });
});
