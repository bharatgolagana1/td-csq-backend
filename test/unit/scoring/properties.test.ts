/**
 * Property-style checks over seeded random surveys and assessments: every
 * published mean lies within 1..5 with at most two decimals, the suppression
 * and count invariants hold on every row, and the published figures agree
 * (to within half a hundredth) with an independent exact computation that
 * rounds nothing until the end, which is what "rounding only at the
 * boundary" guarantees.
 */

import { describe, expect, it } from 'vitest';

import type {
  Rating,
  ScoreRow,
  ScoringSettings,
  SubmittedAssessment,
  SurveyCategory,
  SurveyQuestion,
  SurveyStructure,
} from '../../../src/modules/scoring/engine/index.js';
import {
  OVERALL_REF_ID,
  rankOperators,
  rollupAirport,
  rowKey,
  scoreAssessments,
} from '../../../src/modules/scoring/engine/index.js';

import { category, integer, pick, question, seededRandom, subcategory, survey } from './fixtures.js';


type Random = () => number;

const RATINGS: readonly Rating[] = [1, 2, 3, 4, 5];

// ------------------------------------------------------------ generators

function randomQuestions(random: Random, prefix: string, weighted: boolean): SurveyQuestion[] {
  return Array.from({ length: integer(random, 1, 4) }, (_, i) =>
    question(`${prefix}q${i}`, {
      active: random() > 0.15,
      ...(weighted ? { weightPct: integer(random, 0, 50) } : {}),
    }),
  );
}

function randomSurvey(random: Random): SurveyStructure {
  const weightedCategories = random() > 0.5;
  const categories: SurveyCategory[] = Array.from({ length: integer(random, 1, 4) }, (_, c) => {
    const subcategories = Array.from({ length: integer(random, 0, 3) }, (_, s) =>
      subcategory(`c${c}s${s}`, randomQuestions(random, `c${c}s${s}`, random() > 0.5)),
    );
    const direct = random() > 0.5 ? randomQuestions(random, `c${c}`, random() > 0.5) : [];
    return category(
      `c${c}`,
      { subcategories, questions: direct },
      weightedCategories ? { weightPct: integer(random, 0, 60) } : {},
    );
  });
  return survey(categories);
}

function allQuestions(tree: SurveyStructure): SurveyQuestion[] {
  return tree.categories.flatMap((c) => [...c.subcategories.flatMap((s) => s.questions), ...c.questions]);
}

function randomAssessments(random: Random, tree: SurveyStructure): SubmittedAssessment[] {
  const questions = allQuestions(tree);
  const answer = (): { rating: Rating | null; na: boolean } => {
    const roll = random();
    if (roll < 0.15) return { rating: null, na: true };
    if (roll < 0.2) return { rating: null, na: false };
    return { rating: pick(random, RATINGS), na: false };
  };
  const make = (id: string, kind: 'CUSTOMER' | 'SELF'): SubmittedAssessment => {
    const answers = questions.filter(() => random() > 0.1).map((q) => ({ questionId: q.id, ...answer() }));
    if (kind === 'SELF') return { id, kind, answers };
    const typeRoll = integer(random, 0, 2);
    if (typeRoll === 2) return { id, kind, answers }; // customer without a type
    return { id, kind, customerType: typeRoll === 0 ? 'FF' : 'CB', answers };
  };
  return [
    ...Array.from({ length: integer(random, 0, 8) }, (_, i) => make(`cust${i}`, 'CUSTOMER')),
    ...Array.from({ length: integer(random, 0, 2) }, (_, i) => make(`self${i}`, 'SELF')),
  ];
}

function randomSettings(random: Random): ScoringSettings {
  return { minResponses: integer(random, 0, 4), weightingMode: random() > 0.5 ? 'WEIGHTED' : 'EQUAL' };
}

// ----------------------------------------------------------------- oracle

/** Exact (unrounded) customer means per ref, computed independently of the engine. */
function exactCustomerMeans(tree: SurveyStructure, assessments: readonly SubmittedAssessment[], mode: ScoringSettings['weightingMode']): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const customers = assessments.filter((a) => a.kind === 'CUSTOMER');

  const questionMean = (q: SurveyQuestion): number | null => {
    const ratings: number[] = [];
    for (const a of customers) {
      const last = [...a.answers].reverse().find((x) => x.questionId === q.id);
      if (last && !last.na && last.rating !== null) ratings.push(last.rating);
    }
    const mean = ratings.length === 0 ? null : ratings.reduce((s, r) => s + r, 0) / ratings.length;
    out.set(rowKey({ level: 'QUESTION', refId: q.id }), mean);
    return mean;
  };

  const weightedMeanOf = (items: readonly { mean: number | null; weightPct?: number }[]): number | null => {
    const useWeights = mode === 'WEIGHTED' && items.length > 0 && items.every((i) => i.weightPct !== undefined);
    let num = 0;
    let den = 0;
    for (const item of items) {
      if (item.mean === null) continue;
      const w = useWeights ? (item.weightPct ?? 0) : 1;
      num += w * item.mean;
      den += w;
    }
    return den === 0 ? null : num / den;
  };

  const categoryMeans = tree.categories.map((c) => {
    const subMeans = c.subcategories.map((s) => {
      const mean = weightedMeanOf(
        s.questions.filter((q) => q.active).map((q) => ({ mean: questionMean(q), ...(q.weightPct === undefined ? {} : { weightPct: q.weightPct }) })),
      );
      out.set(rowKey({ level: 'SUBCATEGORY', refId: s.id }), mean);
      return { mean };
    });
    const directMeans = c.questions
      .filter((q) => q.active)
      .map((q) => ({ mean: questionMean(q), ...(q.weightPct === undefined ? {} : { weightPct: q.weightPct }) }));
    const mean = weightedMeanOf([...subMeans, ...directMeans]);
    out.set(rowKey({ level: 'CATEGORY', refId: c.id }), mean);
    return { mean, ...(c.weightPct === undefined ? {} : { weightPct: c.weightPct }) };
  });
  out.set(rowKey({ level: 'OVERALL', refId: OVERALL_REF_ID }), weightedMeanOf(categoryMeans));
  return out;
}

// ------------------------------------------------------------- invariants

function expectPublishedMean(mean: number | null): void {
  if (mean === null) return;
  expect(mean).toBeGreaterThanOrEqual(1);
  expect(mean).toBeLessThanOrEqual(5);
  expect(Math.abs(mean * 100 - Math.round(mean * 100))).toBeLessThan(1e-9);
}

function expectRowInvariants(row: ScoreRow, settings: ScoringSettings, customers: number, selfs: number): void {
  expectPublishedMean(row.customer.mean);
  expectPublishedMean(row.customer.byType.FF.mean);
  expectPublishedMean(row.customer.byType.CB.mean);
  expectPublishedMean(row.self.mean);

  const suppressed = row.customer.n < settings.minResponses;
  expect(row.suppressed === 'INSUFFICIENT_RESPONSES').toBe(suppressed);
  if (suppressed) {
    expect(row.customer.mean).toBeNull();
    expect(row.customer.byType.FF.mean).toBeNull();
    expect(row.customer.byType.CB.mean).toBeNull();
  }
  if (row.customer.byType.FF.n < settings.minResponses) expect(row.customer.byType.FF.mean).toBeNull();
  if (row.customer.byType.CB.n < settings.minResponses) expect(row.customer.byType.CB.mean).toBeNull();
  if (!suppressed) expect(row.customer.mean === null).toBe(row.customer.n === 0);
  expect(row.self.mean === null).toBe(row.self.n === 0);

  expect(row.customer.byType.FF.n + row.customer.byType.CB.n).toBeLessThanOrEqual(row.customer.n);
  expect(row.customer.n).toBeLessThanOrEqual(customers);
  expect(row.self.n).toBeLessThanOrEqual(selfs);
  expect(row.customer.naCount).toBeGreaterThanOrEqual(0);
}

describe('scoreAssessments properties', () => {
  it('holds the publication invariants and matches the exact oracle on 300 random cases', () => {
    const random = seededRandom(2026);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const tree = randomSurvey(random);
      const assessments = randomAssessments(random, tree);
      const settings = randomSettings(random);
      const rows = scoreAssessments(tree, assessments, settings);
      const customers = assessments.filter((a) => a.kind === 'CUSTOMER').length;
      const selfs = assessments.length - customers;

      expect(rows[0]?.level).toBe('OVERALL');
      expect(new Set(rows.map(rowKey)).size).toBe(rows.length);

      const exact = exactCustomerMeans(tree, assessments, settings.weightingMode);
      for (const row of rows) {
        expectRowInvariants(row, settings, customers, selfs);
        const expected = exact.get(rowKey(row));
        expect(expected).not.toBeUndefined();
        if (row.suppressed) continue;
        if (expected === null || expected === undefined) {
          expect(row.customer.mean).toBeNull();
        } else {
          expect(row.customer.mean).not.toBeNull();
          expect(Math.abs((row.customer.mean ?? 0) - expected)).toBeLessThanOrEqual(0.005 + 1e-9);
        }
      }
    }
  });

  it('is independent of SELF assessments for every customer figure', () => {
    const random = seededRandom(99);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const tree = randomSurvey(random);
      const assessments = randomAssessments(random, tree);
      const settings = randomSettings(random);
      const withSelf = scoreAssessments(tree, assessments, settings);
      const withoutSelf = scoreAssessments(tree, assessments.filter((a) => a.kind === 'CUSTOMER'), settings);
      expect(withSelf.map((r) => ({ key: rowKey(r), customer: r.customer, suppressed: r.suppressed }))).toEqual(
        withoutSelf.map((r) => ({ key: rowKey(r), customer: r.customer, suppressed: r.suppressed })),
      );
    }
  });
});

describe('rollupAirport properties', () => {
  it('keeps the airport mean inside the range of its scored operators and rounds once', () => {
    const random = seededRandom(5);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const useShares = random() > 0.3;
      const operators = Array.from({ length: integer(random, 0, 6) }, (_, i) => ({
        acoId: `aco${i}`,
        mean: random() < 0.25 ? null : 1 + Math.round(random() * 400) / 100,
        ...(useShares ? { sharePct: integer(random, 0, 60) } : {}),
      }));
      const result = rollupAirport(operators, { minCoveredSharePct: 0 });
      expectPublishedMean(result.mean);

      const weightOf = (o: (typeof operators)[number]): number =>
        result.marketShareApplied ? (o.sharePct ?? 0) : 1;
      const scored = operators.filter((o) => o.mean !== null && weightOf(o) > 0);
      if (scored.length === 0) {
        expect(result.mean).toBeNull();
        continue;
      }
      const num = scored.reduce((s, o) => s + weightOf(o) * (o.mean ?? 0), 0);
      const den = scored.reduce((s, o) => s + weightOf(o), 0);
      expect(Math.abs((result.mean ?? 0) - num / den)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(result.mean).toBeGreaterThanOrEqual(Math.min(...scored.map((o) => o.mean ?? 0)) - 0.005);
      expect(result.mean).toBeLessThanOrEqual(Math.max(...scored.map((o) => o.mean ?? 0)) + 0.005);
      expect(result.coveredSharePct).toBeGreaterThanOrEqual(0);
      expect(result.coveredSharePct).toBeLessThanOrEqual(100 + 1e-9 + (result.marketShareApplied ? 1000 : 0));
    }
  });
});

describe('rankOperators properties', () => {
  it('yields dense ranks 1..k that never increase with the mean', () => {
    const random = seededRandom(11);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const entries = Array.from({ length: integer(random, 0, 8) }, (_, i) => ({
        acoId: `aco${i}`,
        mean: random() < 0.2 ? null : 1 + Math.round(random() * 40) / 10,
      }));
      const ranked = rankOperators(entries);
      const ranks = ranked.filter((e) => e.rank !== null).map((e) => e.rank ?? 0);
      const distinct = new Set(ranked.filter((e) => e.mean !== null).map((e) => e.mean));
      expect(new Set(ranks)).toEqual(new Set(Array.from({ length: distinct.size }, (_, i) => i + 1)));
      expect(ranked.every((e) => e.rankOf === ranks.length)).toBe(true);
      for (const a of ranked) {
        for (const b of ranked) {
          if (a.mean === null || b.mean === null || a.rank === null || b.rank === null) continue;
          if (a.mean > b.mean) expect(a.rank).toBeLessThan(b.rank);
          if (a.mean === b.mean) expect(a.rank).toBe(b.rank);
        }
      }
    }
  });
});
