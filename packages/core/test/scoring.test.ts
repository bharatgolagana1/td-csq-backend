import { describe, expect, it } from 'vitest';
import {
  composite,
  envelope,
  rollupCategories,
  scoreQuestions,
  applyMarketShare,
  round1,
  type QuestionSpec,
  type SubmittedAssessment,
  type WeightingProfile,
} from '../src/index.js';

const q = (code: string, categoryCode: string, weightBp: number): QuestionSpec => ({
  code,
  categoryCode,
  answerType: 'RATING_5',
  weightBp,
  scored: true,
  applicableDirections: ['EXPORT', 'IMPORT'],
});

const specs = new Map<string, QuestionSpec>([
  ['A', q('A', 'PROCESS', 5000)],
  ['B', q('B', 'PROCESS', 5000)],
  ['C', q('C', 'INFRA', 10000)],
]);

const profile: WeightingProfile = {
  profileId: 'acfi-v1',
  version: 1,
  categoryWeightBp: {
    INTERNATIONAL: { PROCESS: 5000, INFRA: 5000 },
    DOMESTIC: { PROCESS: 5000, INFRA: 5000 },
  },
  weightingBasis: 'EQUAL',
};

const mk = (
  answers: SubmittedAssessment['answers'],
  kind: SubmittedAssessment['assessorKind'] = 'CUSTOMER',
): SubmittedAssessment => ({
  assessmentId: 'a1',
  assessorKind: kind,
  formScope: 'INTERNATIONAL',
  answers,
});

describe('S0/S1 question scoring', () => {
  it('averages the two directions into one question score', () => {
    const r = scoreQuestions(
      mk([{ questionCode: 'A', ratings: [
        { direction: 'EXPORT', rating: 'EXCELLENT' },   // 5
        { direction: 'IMPORT', rating: 'GOOD' },        // 3
      ] }]),
      specs,
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.value).toBe(4);
    expect(r[0]!.byDirection).toEqual({ EXPORT: 5, IMPORT: 3 });
  });

  it('excludes NA from the average rather than treating it as zero', () => {
    const r = scoreQuestions(
      mk([{ questionCode: 'A', ratings: [
        { direction: 'EXPORT', rating: 'FAIR' },  // 2
        { direction: 'IMPORT', rating: 'NA' },
      ] }]),
      specs,
    );
    expect(r[0]!.value).toBe(2);
    expect(r[0]!.byDirection).toEqual({ EXPORT: 2 });
  });

  it('drops a question whose every direction is NA', () => {
    const r = scoreQuestions(
      mk([{ questionCode: 'A', ratings: [
        { direction: 'EXPORT', rating: 'NA' },
        { direction: 'IMPORT', rating: 'NA' },
      ] }]),
      specs,
    );
    expect(r).toHaveLength(0);
  });

  it('excludes SELF assessments entirely, however complete they are', () => {
    const answers = [{ questionCode: 'A', ratings: [
      { direction: 'EXPORT' as const, rating: 'EXCELLENT' as const },
      { direction: 'IMPORT' as const, rating: 'EXCELLENT' as const },
    ] }];
    expect(scoreQuestions(mk(answers, 'SELF'), specs)).toHaveLength(0);
    expect(scoreQuestions(mk(answers, 'CUSTOMER'), specs)).toHaveLength(1);
    expect(scoreQuestions(mk(answers, 'EXTERNAL'), specs)).toHaveLength(1);
  });

  it('ignores a rating sent for a direction the question does not ask for', () => {
    const r = scoreQuestions(
      mk([{ questionCode: 'A', ratings: [
        { direction: 'EXPORT', rating: 'POOR' },
        { direction: 'INBOUND', rating: 'EXCELLENT' },
      ] }]),
      specs,
    );
    expect(r[0]!.value).toBe(1);
  });
});

describe('S2 category rollup', () => {
  it('redistributes weight so NA does not depress the category', () => {
    // A answered POOR(1), B entirely NA. Category must be 1.0, not 0.5.
    const scores = scoreQuestions(
      mk([
        { questionCode: 'A', ratings: [{ direction: 'EXPORT', rating: 'POOR' }] },
        { questionCode: 'B', ratings: [{ direction: 'EXPORT', rating: 'NA' }] },
      ]),
      specs,
    );
    const cats = rollupCategories(scores, specs, 'INTERNATIONAL');
    const process = cats.find((c) => c.categoryCode === 'PROCESS')!;
    expect(process.value).toBe(1);
    expect(process.coverageBp).toBe(5000); // half the category's weight answered
  });

  it('reports full coverage when every question in a category scored', () => {
    const scores = scoreQuestions(
      mk([
        { questionCode: 'A', ratings: [{ direction: 'EXPORT', rating: 'EXCELLENT' }] },
        { questionCode: 'B', ratings: [{ direction: 'EXPORT', rating: 'GOOD' }] },
      ]),
      specs,
    );
    const process = rollupCategories(scores, specs, 'INTERNATIONAL')
      .find((c) => c.categoryCode === 'PROCESS')!;
    expect(process.value).toBe(4);
    expect(process.coverageBp).toBe(10000);
  });
});

describe('S3 composite', () => {
  it('weights categories and renormalises over those that scored', () => {
    const scores = scoreQuestions(
      mk([
        { questionCode: 'A', ratings: [{ direction: 'EXPORT', rating: 'EXCELLENT' }] }, // PROCESS 5
        { questionCode: 'B', ratings: [{ direction: 'EXPORT', rating: 'EXCELLENT' }] }, // PROCESS 5
        { questionCode: 'C', ratings: [{ direction: 'EXPORT', rating: 'GOOD' }] },      // INFRA 3
      ]),
      specs,
    );
    const cats = rollupCategories(scores, specs, 'INTERNATIONAL');
    const { value } = composite(cats, profile, 'INTERNATIONAL');
    expect(value).toBe(4); // (5*5000 + 3*5000)/10000
  });

  it('returns null when nothing scored', () => {
    expect(composite([], profile, 'INTERNATIONAL').value).toBeNull();
  });
});

describe('S4 market share', () => {
  const rows = [{ acoId: 'x', value: 4.0 }, { acoId: 'y', value: 2.0 }];

  it('is a plain mean when the stage is off, and says so', () => {
    const r = applyMarketShare(rows, { mode: 'OFF', sharesBp: {} });
    expect(r.value).toBe(3);
    expect(r.applied).toBe(false);
  });

  it('weights by share when enabled, so an 80 percent operator dominates', () => {
    const r = applyMarketShare(rows, { mode: 'AIRPORT_ROLLUP', sharesBp: { x: 8000, y: 2000 } });
    expect(r.value).toBeCloseTo(3.6, 10);
    expect(r.applied).toBe(true);
  });
});

describe('publication gates', () => {
  const base = { coverageBp: 10000, profile, marketShareApplied: false, scored: true };

  it('suppresses a score built from too few responses', () => {
    const e = envelope({ ...base, value: 4.2, responseCount: 3 });
    expect(e.value).toBeNull();
    expect(e.suppression).toBe('BELOW_MIN_RESPONSES');
  });

  it('suppresses a score built from too little of the instrument', () => {
    const e = envelope({ ...base, value: 4.2, responseCount: 20, coverageBp: 4000 });
    expect(e.value).toBeNull();
    expect(e.suppression).toBe('BELOW_MIN_COVERAGE');
  });

  it('publishes and rounds to one decimal when both gates pass', () => {
    const e = envelope({ ...base, value: 4.24, responseCount: 20 });
    expect(e.value).toBe(4.2);
    expect(e.suppression).toBe('NONE');
    expect(e.weightingProfile).toEqual({ profileId: 'acfi-v1', version: 1 });
  });

  it('always carries the profile that produced it, so a score is reproducible', () => {
    expect(envelope({ ...base, value: 3, responseCount: 9 }).weightingProfile.version).toBe(1);
  });
});

describe('rounding', () => {
  it('rounds half up to one decimal', () => {
    expect(round1(3.44)).toBe(3.4);
    expect(round1(3.45)).toBe(3.5);
    expect(round1(2.999)).toBe(3);
  });
});
