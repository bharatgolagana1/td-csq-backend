import { describe, expect, it } from 'vitest';

import { OVERALL_REF_ID, scoreAssessments } from '../../../src/modules/scoring/engine/index.js';

import {
  category,
  customer,
  question,
  row,
  selfAssessment,
  settings,
  standardSurvey,
  subcategory,
  survey,
} from './fixtures.js';


describe('scoreAssessments: question level', () => {
  it('scores 5, 4, NA, 3 as 4.00 with n = 3 and naCount = 1 (REQUIREMENTS §22)', () => {
    const tree = survey([category('c', { questions: [question('q')] })]);
    const rows = scoreAssessments(
      tree,
      [
        customer('a', 'FF', { q: 5 }),
        customer('b', 'FF', { q: 4 }),
        customer('c', 'CB', { q: 'NA' }),
        customer('d', 'CB', { q: 3 }),
      ],
      settings(),
    );
    const q = row(rows, 'QUESTION', 'q');
    expect(q.customer).toEqual({
      mean: 4,
      n: 3,
      naCount: 1,
      byType: { FF: { mean: 4.5, n: 2 }, CB: { mean: 3, n: 1 } },
    });
    expect(q.suppressed).toBeUndefined();
    expect(q.self).toEqual({ mean: null, n: 0 });
  });

  it('gives an NA-only question no score and leaves its parent to the other questions', () => {
    const tree = survey([category('c', { questions: [question('q1'), question('q2')] })]);
    const rows = scoreAssessments(
      tree,
      [customer('a', 'FF', { q1: 'NA', q2: 4 }), customer('b', 'FF', { q1: 'NA', q2: 2 })],
      settings({ minResponses: 1 }),
    );
    const q1 = row(rows, 'QUESTION', 'q1');
    expect(q1.customer.mean).toBeNull();
    expect(q1.customer.n).toBe(0);
    expect(q1.customer.naCount).toBe(2);
    expect(q1.suppressed).toBe('INSUFFICIENT_RESPONSES');
    expect(row(rows, 'CATEGORY', 'c').customer.mean).toBe(3);
    expect(row(rows, 'OVERALL', OVERALL_REF_ID).customer.mean).toBe(3);
  });

  it('ignores an answer that is neither rated nor NA', () => {
    const tree = survey([category('c', { questions: [question('q')] })]);
    const rows = scoreAssessments(tree, [customer('a', 'FF', { q: null }), customer('b', 'FF', { q: 5 })], settings());
    expect(row(rows, 'QUESTION', 'q').customer).toMatchObject({ mean: 5, n: 1, naCount: 0 });
  });

  it('skips inactive questions entirely', () => {
    const tree = survey([category('c', { questions: [question('q1'), question('q2', { active: false })] })]);
    const rows = scoreAssessments(tree, [customer('a', 'FF', { q1: 5, q2: 1 })], settings());
    expect(rows.find((r) => r.refId === 'q2')).toBeUndefined();
    expect(row(rows, 'CATEGORY', 'c').customer.mean).toBe(5);
  });

  it('counts an assessment once when it answers the same question twice (last answer wins)', () => {
    const tree = survey([category('c', { questions: [question('q')] })]);
    const twice = {
      id: 'a',
      kind: 'CUSTOMER' as const,
      customerType: 'FF' as const,
      answers: [
        { questionId: 'q', rating: 1 as const, na: false },
        { questionId: 'q', rating: 5 as const, na: false },
      ],
    };
    expect(row(scoreAssessments(tree, [twice], settings()), 'QUESTION', 'q').customer).toMatchObject({ mean: 5, n: 1 });
  });
});

describe('scoreAssessments: roll-up', () => {
  it('emits every level once, OVERALL first, in pre-order of the tree', () => {
    const rows = scoreAssessments(standardSurvey(), [], settings({ minResponses: 0 }));
    expect(rows.map((r) => `${r.level}:${r.refId}`)).toEqual([
      'OVERALL:OVERALL',
      'CATEGORY:c1',
      'SUBCATEGORY:s1',
      'QUESTION:q1',
      'QUESTION:q2',
      'SUBCATEGORY:s2',
      'QUESTION:q3',
      'CATEGORY:c2',
      'QUESTION:q4',
    ]);
  });

  it('builds each parent as the mean of its children means (not the pooled ratings)', () => {
    // s1: q1 = 5 (one rating), q2 = 1 (three ratings) → mean of means = 3, pooled would be 2.
    const rows = scoreAssessments(
      standardSurvey(),
      [
        customer('a', 'FF', { q1: 5, q2: 1, q3: 3, q4: 4 }),
        customer('b', 'FF', { q1: 'NA', q2: 1, q3: 3, q4: 4 }),
        customer('c', 'FF', { q1: 'NA', q2: 1, q3: 3, q4: 4 }),
      ],
      settings(),
    );
    expect(row(rows, 'SUBCATEGORY', 's1').customer.mean).toBe(3);
    expect(row(rows, 'CATEGORY', 'c1').customer.mean).toBe(3); // (3 + 3) / 2
    expect(row(rows, 'CATEGORY', 'c2').customer.mean).toBe(4);
    expect(row(rows, 'OVERALL', OVERALL_REF_ID).customer.mean).toBe(3.5);
  });

  it('counts n as distinct assessments, not answers, at every level', () => {
    const rows = scoreAssessments(standardSurvey(), [customer('a', 'FF', { q1: 5, q2: 4, q3: 3, q4: 2 })], settings());
    for (const r of rows) expect(r.customer.n).toBe(1);
  });

  it('sums naCount up the tree', () => {
    const rows = scoreAssessments(
      standardSurvey(),
      [customer('a', 'FF', { q1: 'NA', q2: 'NA', q3: 4, q4: 'NA' }), customer('b', 'CB', { q1: 'NA', q2: 3, q3: 4, q4: 4 })],
      settings(),
    );
    expect(row(rows, 'SUBCATEGORY', 's1').customer.naCount).toBe(3);
    expect(row(rows, 'CATEGORY', 'c1').customer.naCount).toBe(3);
    expect(row(rows, 'CATEGORY', 'c2').customer.naCount).toBe(1);
    expect(row(rows, 'OVERALL', OVERALL_REF_ID).customer.naCount).toBe(4);
  });

  it('treats subcategories and direct questions of a category as equal siblings', () => {
    const tree = survey([
      category('c', { subcategories: [subcategory('s', [question('q1'), question('q2')])], questions: [question('q3')] }),
    ]);
    const rows = scoreAssessments(tree, [customer('a', 'FF', { q1: 5, q2: 5, q3: 2 })], settings());
    expect(row(rows, 'CATEGORY', 'c').customer.mean).toBe(3.5);
  });

  it('rounds only at the boundary: the parent is built from exact child means', () => {
    // q1 = 14/3 = 4.666…, q2 = 4 → exact mean 4.333… → 4.33. Rounded first: (4.67 + 4) / 2 = 4.335 → 4.34.
    const tree = survey([category('c', { subcategories: [subcategory('s', [question('q1'), question('q2')])] })]);
    const rows = scoreAssessments(
      tree,
      [customer('a', 'FF', { q1: 5, q2: 4 }), customer('b', 'FF', { q1: 5, q2: 4 }), customer('c', 'FF', { q1: 4, q2: 4 })],
      settings(),
    );
    expect(row(rows, 'QUESTION', 'q1').customer.mean).toBe(4.67);
    expect(row(rows, 'SUBCATEGORY', 's').customer.mean).toBe(4.33);
  });

  it('scores an empty survey as a single OVERALL row without a mean', () => {
    const rows = scoreAssessments(survey([]), [customer('a', 'FF', { q: 5 })], settings({ minResponses: 0 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'OVERALL', refId: OVERALL_REF_ID, customer: { mean: null, n: 0 } });
  });
});

describe('scoreAssessments: weighting', () => {
  const tree = survey([
    category('c1', { questions: [question('q1')] }, { weightPct: 60 }),
    category('c2', { questions: [question('q2')] }, { weightPct: 40 }),
  ]);
  const data = [customer('a', 'FF', { q1: 5, q2: 3 })];

  it('EQUAL averages the categories regardless of weightPct', () => {
    expect(row(scoreAssessments(tree, data, settings({ weightingMode: 'EQUAL' })), 'OVERALL', OVERALL_REF_ID).customer.mean).toBe(4);
  });

  it('WEIGHTED applies category weightPct', () => {
    expect(row(scoreAssessments(tree, data, settings({ weightingMode: 'WEIGHTED' })), 'OVERALL', OVERALL_REF_ID).customer.mean).toBe(4.2);
  });

  it('WEIGHTED applies question weightPct inside a subcategory', () => {
    const weightedTree = survey([
      category('c', { subcategories: [subcategory('s', [question('q1', { weightPct: 75 }), question('q2', { weightPct: 25 })])] }),
    ]);
    const answers = [customer('a', 'FF', { q1: 5, q2: 1 })];
    expect(row(scoreAssessments(weightedTree, answers, settings({ weightingMode: 'WEIGHTED' })), 'SUBCATEGORY', 's').customer.mean).toBe(4);
    expect(row(scoreAssessments(weightedTree, answers, settings({ weightingMode: 'EQUAL' })), 'SUBCATEGORY', 's').customer.mean).toBe(3);
  });

  it('WEIGHTED falls back to equal weights when the survey carries no weights', () => {
    const unweighted = survey([category('c1', { questions: [question('q1')] }), category('c2', { questions: [question('q2')] })]);
    expect(row(scoreAssessments(unweighted, data, settings({ weightingMode: 'WEIGHTED' })), 'OVERALL', OVERALL_REF_ID).customer.mean).toBe(4);
  });

  it('redistributes the weight of a category without a score', () => {
    const three = survey([
      category('c1', { questions: [question('q1')] }, { weightPct: 50 }),
      category('c2', { questions: [question('q2')] }, { weightPct: 30 }),
      category('c3', { questions: [question('q3')] }, { weightPct: 20 }),
    ]);
    const rows = scoreAssessments(
      three,
      [customer('a', 'FF', { q1: 5, q2: 4, q3: 'NA' }), customer('b', 'FF', { q1: 4, q2: 4, q3: 'NA' })],
      settings({ weightingMode: 'WEIGHTED' }),
    );
    expect(row(rows, 'CATEGORY', 'c3').customer.mean).toBeNull();
    // (4.5 × 50 + 4 × 30) / 80 = 4.3125 → 4.31
    expect(row(rows, 'OVERALL', OVERALL_REF_ID).customer.mean).toBe(4.31);
  });
});

describe('scoreAssessments: suppression', () => {
  it('suppresses a question below minResponses while its parent, judged by its own n, still publishes', () => {
    const tree = survey([category('c', { subcategories: [subcategory('s', [question('q1'), question('q2')])] })]);
    const rows = scoreAssessments(
      tree,
      [
        customer('a', 'FF', { q1: 5, q2: 'NA' }),
        customer('b', 'FF', { q1: 5, q2: 'NA' }),
        customer('c', 'FF', { q1: 'NA', q2: 3 }),
        customer('d', 'FF', { q1: 'NA', q2: 3 }),
        customer('e', 'FF', { q1: 'NA', q2: 3 }),
      ],
      settings({ minResponses: 3 }),
    );
    const q1 = row(rows, 'QUESTION', 'q1');
    expect(q1.suppressed).toBe('INSUFFICIENT_RESPONSES');
    expect(q1.customer).toMatchObject({ mean: null, n: 2, naCount: 3, byType: { FF: { mean: null, n: 2 } } });
    expect(row(rows, 'QUESTION', 'q2').suppressed).toBeUndefined();
    const s = row(rows, 'SUBCATEGORY', 's');
    expect(s.suppressed).toBeUndefined();
    expect(s.customer).toMatchObject({ mean: 4, n: 5 }); // built from the exact q1 mean (5), not from null
  });

  it('suppresses subcategory, category and overall when too few customers answered anything', () => {
    const rows = scoreAssessments(
      standardSurvey(),
      [customer('a', 'FF', { q1: 5, q2: 5, q3: 5, q4: 5 }), customer('b', 'CB', { q1: 4, q2: 4, q3: 4, q4: 4 })],
      settings({ minResponses: 3 }),
    );
    for (const r of rows) {
      expect(r.suppressed).toBe('INSUFFICIENT_RESPONSES');
      expect(r.customer.mean).toBeNull();
      expect(r.customer.byType.FF.mean).toBeNull();
      expect(r.customer.byType.CB.mean).toBeNull();
      expect(r.customer.n).toBe(2);
    }
  });

  it('suppresses one category but not the overall when the other category carries enough responses', () => {
    const rows = scoreAssessments(
      standardSurvey(),
      [
        customer('a', 'FF', { q1: 5, q2: 5, q3: 5, q4: 2 }),
        customer('b', 'FF', { q1: 5, q2: 5, q3: 5, q4: 2 }),
        customer('c', 'FF', { q1: 5, q2: 5, q3: 5, q4: 'NA' }),
      ],
      settings({ minResponses: 3 }),
    );
    expect(row(rows, 'CATEGORY', 'c2')).toMatchObject({ suppressed: 'INSUFFICIENT_RESPONSES', customer: { mean: null, n: 2 } });
    expect(row(rows, 'QUESTION', 'q4').suppressed).toBe('INSUFFICIENT_RESPONSES');
    expect(row(rows, 'CATEGORY', 'c1').suppressed).toBeUndefined();
    const overall = row(rows, 'OVERALL', OVERALL_REF_ID);
    expect(overall.suppressed).toBeUndefined();
    expect(overall.customer).toMatchObject({ mean: 3.5, n: 3 }); // (5 + 2) / 2 with the exact c2 mean
  });

  it('publishes everything when n meets the threshold exactly', () => {
    const tree = survey([category('c', { questions: [question('q')] })]);
    const rows = scoreAssessments(
      tree,
      [customer('a', 'FF', { q: 5 }), customer('b', 'FF', { q: 4 }), customer('c', 'FF', { q: 3 })],
      settings({ minResponses: 3 }),
    );
    expect(row(rows, 'QUESTION', 'q')).toMatchObject({ customer: { mean: 4, n: 3 } });
    expect(row(rows, 'QUESTION', 'q').suppressed).toBeUndefined();
  });
});

describe('scoreAssessments: SELF isolation', () => {
  const tree = survey([category('c', { subcategories: [subcategory('s', [question('q1'), question('q2')])] })]);
  const customers = [customer('a', 'FF', { q1: 4, q2: 4 }), customer('b', 'CB', { q1: 2, q2: 'NA' })];

  it('computes self figures separately and never lets them enter customer figures', () => {
    const withSelf = scoreAssessments(tree, [...customers, selfAssessment('self', { q1: 5, q2: 5 })], settings());
    const without = scoreAssessments(tree, customers, settings());
    for (const r of withSelf) {
      const counterpart = row(without, r.level, r.refId);
      expect(r.customer).toEqual(counterpart.customer);
      expect(r.suppressed).toBe(counterpart.suppressed);
      expect(r.self).toEqual({ mean: 5, n: 1 });
    }
  });

  it('excludes self NA from naCount and from the self mean', () => {
    const rows = scoreAssessments(tree, [...customers, selfAssessment('self', { q1: 3, q2: 'NA' })], settings());
    expect(row(rows, 'QUESTION', 'q2').self).toEqual({ mean: null, n: 0 });
    expect(row(rows, 'QUESTION', 'q2').customer.naCount).toBe(1);
    expect(row(rows, 'SUBCATEGORY', 's').self).toEqual({ mean: 3, n: 1 });
  });

  it('never suppresses the self figure, even when the customer figure is suppressed', () => {
    const rows = scoreAssessments(tree, [...customers, selfAssessment('self', { q1: 2, q2: 4 })], settings({ minResponses: 10 }));
    const s = row(rows, 'SUBCATEGORY', 's');
    expect(s.suppressed).toBe('INSUFFICIENT_RESPONSES');
    expect(s.customer.mean).toBeNull();
    expect(s.self).toEqual({ mean: 3, n: 1 });
  });

  it('averages several self assessments', () => {
    const rows = scoreAssessments(tree, [selfAssessment('s1', { q1: 2 }), selfAssessment('s2', { q1: 4 })], settings({ minResponses: 0 }));
    expect(row(rows, 'QUESTION', 'q1').self).toEqual({ mean: 3, n: 2 });
  });
});

describe('scoreAssessments: FF / CB split', () => {
  const tree = survey([category('c', { questions: [question('q')] })]);

  it('splits the customer figure by stakeholder type', () => {
    const rows = scoreAssessments(
      tree,
      [customer('a', 'FF', { q: 5 }), customer('b', 'FF', { q: 5 }), customer('c', 'CB', { q: 3 })],
      settings({ minResponses: 1 }),
    );
    expect(row(rows, 'QUESTION', 'q').customer).toEqual({
      mean: 4.33,
      n: 3,
      naCount: 0,
      byType: { FF: { mean: 5, n: 2 }, CB: { mean: 3, n: 1 } },
    });
  });

  it('counts a customer without a type in the total but in neither split', () => {
    const rows = scoreAssessments(tree, [customer('a', undefined, { q: 4 }), customer('b', 'FF', { q: 2 })], settings());
    expect(row(rows, 'QUESTION', 'q').customer).toMatchObject({ mean: 3, n: 2, byType: { FF: { mean: 2, n: 1 }, CB: { mean: null, n: 0 } } });
  });

  it('hides a split whose own n is below minResponses while the total publishes', () => {
    const rows = scoreAssessments(
      tree,
      [customer('a', 'FF', { q: 5 }), customer('b', 'FF', { q: 5 }), customer('c', 'CB', { q: 3 })],
      settings({ minResponses: 2 }),
    );
    const q = row(rows, 'QUESTION', 'q');
    expect(q.suppressed).toBeUndefined();
    expect(q.customer.mean).toBe(4.33);
    expect(q.customer.byType).toEqual({ FF: { mean: 5, n: 2 }, CB: { mean: null, n: 1 } });
  });
});
