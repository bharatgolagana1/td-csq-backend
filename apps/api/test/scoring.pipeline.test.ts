import { describe, expect, it } from 'vitest';
import type { QuestionSpec } from '@csq/core';
import type { AssessmentInput, InstrumentInput } from '../src/modules/scoring/scoring.inputs.js';
import {
  cohortStatistics,
  customerTrack,
  gapOf,
  parameterCounts,
  publishTrack,
  rankAirports,
  selfTrack,
  specsOf,
  tallyRatings,
  toWeightingProfile,
  weightingProblems,
  withPercentages,
  type AirportCandidate,
} from '../src/modules/scoring/scoring.pipeline.js';

/**
 * The composition around @csq/core, tested without a database. What gets
 * published and what gets withheld is the pair of decisions this system cannot
 * afford to get wrong, and neither of them needs Mongo to be exercised.
 */

const CATEGORIES = [
  { code: 'INFRASTRUCTURE_FACILITIES', label: 'Infrastructure / Facilities', count: 8 },
  { code: 'SECURITY_SAFETY', label: 'Security / Safety', count: 6 },
  { code: 'PROCESSES', label: 'Processes', count: 5 },
  { code: 'TRADE_FACILITATION', label: 'Trade Facilitation', count: 4 },
] as const;

function instrument(): InstrumentInput {
  const questions = CATEGORIES.flatMap((category) =>
    Array.from({ length: category.count }, (_unused, index) => ({
      code: `ACFI.${category.code}.Q${index + 1}`,
      categoryCode: category.code,
      answerType: 'RATING_5' as const,
      weightBp: 1000,
      scored: true,
      applicableDirections: ['EXPORT', 'IMPORT'] as const,
    })),
  );

  return {
    _id: 'instrument-acfi-csq-v1',
    code: 'ACFI_CSQ',
    version: 1,
    formScope: 'INTERNATIONAL',
    sourceRef: null,
    questions: questions.map((q) => ({ ...q, applicableDirections: [...q.applicableDirections] })),
  };
}

const PROFILE = toWeightingProfile({
  _id: 'profile-acfi-csq-v3',
  code: 'ACFI_CSQ',
  version: 3,
  basis: 'CONFIGURED',
  state: 'PUBLISHED',
  snapshotId: null,
  weights: {
    INTERNATIONAL: {
      categories: {
        INFRASTRUCTURE_FACILITIES: 4000,
        SECURITY_SAFETY: 2000,
        PROCESSES: 2000,
        TRADE_FACILITATION: 2000,
      },
      questions: {},
    },
    DOMESTIC: { categories: {}, questions: {} },
  },
});

const SPECS: ReadonlyMap<string, QuestionSpec> = specsOf(instrument());

function assessment(
  id: string,
  kind: AssessmentInput['assessorKind'],
  rate: (categoryCode: string) => 'EXCELLENT' | 'VERY_GOOD' | 'GOOD' | 'FAIR' | 'POOR' | 'NA',
  only?: readonly string[],
): AssessmentInput {
  return {
    _id: id,
    cycleId: '01J000000000000000000CYCLE',
    acoOrgId: '01J00000000000000000000ACO',
    participationId: null,
    assessorKind: kind,
    formScope: 'INTERNATIONAL',
    instrumentId: 'instrument-acfi-csq-v1',
    state: 'SUBMITTED',
    answers: [...SPECS.values()]
      .filter((spec) => only === undefined || only.includes(spec.categoryCode))
      .map((spec) => ({
        questionCode: spec.code,
        ratings: [
          { direction: 'EXPORT' as const, rating: rate(spec.categoryCode) },
          { direction: 'IMPORT' as const, rating: rate(spec.categoryCode) },
        ],
      })),
  };
}

const excellentInfrastructure = (categoryCode: string): 'EXCELLENT' | 'VERY_GOOD' =>
  categoryCode === 'INFRASTRUCTURE_FACILITIES' ? 'EXCELLENT' : 'VERY_GOOD';

describe('scoring pipeline', () => {
  it('weights categories into the composite the profile describes', () => {
    const customers = Array.from({ length: 6 }, (_unused, i) =>
      assessment(`c${i}`, 'CUSTOMER', excellentInfrastructure),
    );

    const track = customerTrack(customers, SPECS, PROFILE, 'INTERNATIONAL');
    const published = publishTrack(track, PROFILE, { scored: true, marketShareApplied: false });

    // 5 at 4000bp and 4 at the remaining 6000bp
    expect(published.overall.value).toBe(4.4);
    expect(published.overall.scoreCoverageBp).toBe(10_000);
    expect(published.overall.responseCount).toBe(6);
    expect(published.overall.suppression).toBe('NONE');
    expect(published.overall.weightingProfile).toEqual({ profileId: PROFILE.profileId, version: 3 });
  });

  it('withholds a score built from too few voices, and says which gate stopped it', () => {
    const customers = Array.from({ length: 4 }, (_unused, i) =>
      assessment(`c${i}`, 'CUSTOMER', () => 'VERY_GOOD'),
    );

    const published = publishTrack(
      customerTrack(customers, SPECS, PROFILE, 'INTERNATIONAL'),
      PROFILE,
      { scored: true, marketShareApplied: false },
    );

    expect(published.overall.value).toBeNull();
    expect(published.overall.suppression).toBe('BELOW_MIN_RESPONSES');
    // the count is still reported: a thin score is visibly thin, not absent
    expect(published.overall.responseCount).toBe(4);
  });

  it('withholds a score built from too little of the instrument', () => {
    const customers = Array.from({ length: 6 }, (_unused, i) =>
      assessment(`c${i}`, 'CUSTOMER', () => 'VERY_GOOD', ['PROCESSES', 'TRADE_FACILITATION']),
    );

    const published = publishTrack(
      customerTrack(customers, SPECS, PROFILE, 'INTERNATIONAL'),
      PROFILE,
      { scored: true, marketShareApplied: false },
    );

    expect(published.overall.value).toBeNull();
    expect(published.overall.suppression).toBe('BELOW_MIN_COVERAGE');
    expect(published.overall.scoreCoverageBp).toBe(4000);
  });

  it('says NOT_YET_SCORED while a cycle is open, which is not the same as suppressed', () => {
    const customers = Array.from({ length: 6 }, (_unused, i) =>
      assessment(`c${i}`, 'CUSTOMER', () => 'EXCELLENT'),
    );

    const published = publishTrack(
      customerTrack(customers, SPECS, PROFILE, 'INTERNATIONAL'),
      PROFILE,
      { scored: false, marketShareApplied: false },
    );

    expect(published.overall.value).toBeNull();
    expect(published.overall.suppression).toBe('NOT_YET_SCORED');
  });

  it('keeps a self assessment out of the customer track entirely', () => {
    const customers = [
      ...Array.from({ length: 5 }, (_unused, i) => assessment(`c${i}`, 'CUSTOMER', () => 'GOOD')),
      assessment('self', 'SELF', () => 'EXCELLENT'),
    ];

    const track = customerTrack(customers, SPECS, PROFILE, 'INTERNATIONAL');
    const published = publishTrack(track, PROFILE, { scored: true, marketShareApplied: false });

    expect(published.overall.value).toBe(3);
    expect(published.overall.responseCount).toBe(5);
  });

  it('reports the self assessment on its own track and the gap between the two', () => {
    const returns = [
      ...Array.from({ length: 5 }, (_unused, i) => assessment(`c${i}`, 'CUSTOMER', () => 'GOOD')),
      assessment('self', 'SELF', () => 'EXCELLENT'),
    ];

    const own = selfTrack(returns, SPECS, PROFILE, 'INTERNATIONAL');
    const customers = publishTrack(
      customerTrack(returns, SPECS, PROFILE, 'INTERNATIONAL'),
      PROFILE,
      { scored: true, marketShareApplied: false },
    );

    expect(own.value).toBe(5);
    expect(own.responseCount).toBe(1);
    expect(gapOf(own.value, customers.overall.value)).toBe(2);
  });

  it('gives every assessor an equal voice rather than the one who answered most', () => {
    const wide = Array.from({ length: 5 }, (_unused, i) => assessment(`c${i}`, 'CUSTOMER', () => 'POOR'));
    const narrow = assessment('loud', 'CUSTOMER', () => 'EXCELLENT', ['PROCESSES']);

    const track = customerTrack([...wide, narrow], SPECS, PROFILE, 'INTERNATIONAL');
    const processes = track.categories.find((c) => c.categoryCode === 'PROCESSES');

    // five ones and one five, not a weighting by how much each assessor typed
    expect(processes?.value).toBeCloseTo((1 * 5 + 5) / 6, 10);
    expect(processes?.responseCount).toBe(6);
  });

  it('drops NA from the calculation instead of scoring it as a sixth band', () => {
    const customers = Array.from({ length: 6 }, (_unused, i) =>
      assessment(`c${i}`, 'CUSTOMER', (code) => (code === 'TRADE_FACILITATION' ? 'NA' : 'EXCELLENT')),
    );

    const track = customerTrack(customers, SPECS, PROFILE, 'INTERNATIONAL');

    expect(track.categories.map((c) => c.categoryCode)).not.toContain('TRADE_FACILITATION');
    expect(track.value).toBe(5);
    // the composite is whole against the categories that answered, and the
    // coverage says which share of the instrument that was
    expect(track.coverageBp).toBe(8000);
  });

  it('refuses a profile whose weights do not sum to the whole instrument', () => {
    const short = toWeightingProfile({
      _id: 'profile-short',
      code: 'ACFI_CSQ',
      version: 1,
      basis: 'CONFIGURED',
      state: 'PUBLISHED',
      snapshotId: null,
      weights: {
        INTERNATIONAL: { categories: { INFRASTRUCTURE_FACILITIES: 4000 }, questions: {} },
        DOMESTIC: { categories: {}, questions: {} },
      },
    });

    expect(weightingProblems(short, 'INTERNATIONAL')).toHaveLength(1);
    expect(weightingProblems(PROFILE, 'INTERNATIONAL')).toHaveLength(0);
    expect(weightingProblems(PROFILE, 'DOMESTIC')).toHaveLength(1);
  });

  it('counts parameters per category the way the dashboard states them', () => {
    const counts = parameterCounts(SPECS);
    expect(counts.get('INFRASTRUCTURE_FACILITIES')).toBe(8);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(23);
  });

  it('tallies directional ratings, excluding NA and excluding the operator itself', () => {
    const returns = [
      ...Array.from({ length: 2 }, (_unused, i) =>
        assessment(`c${i}`, 'CUSTOMER', (code) => (code === 'PROCESSES' ? 'NA' : 'EXCELLENT')),
      ),
      assessment('self', 'SELF', () => 'POOR'),
    ];

    const tally = tallyRatings(returns, SPECS);
    const excellent = tally.find((row) => row.key === 'EXCELLENT');
    const poor = tally.find((row) => row.key === 'POOR');

    // 18 questions that were not NA, two directions, two customers
    expect(excellent?.count).toBe(72);
    expect(poor?.count).toBe(0);
    expect(tally.reduce((sum, row) => sum + row.percent, 0)).toBe(100);
  });

  it('keeps whole percentages summing to 100', () => {
    const rows = withPercentages([
      { key: 'EXCELLENT', count: 1 },
      { key: 'VERY_GOOD', count: 1 },
      { key: 'GOOD', count: 1 },
      { key: 'FAIR', count: 0 },
      { key: 'POOR', count: 0 },
    ]);

    expect(rows.reduce((sum, row) => sum + row.percent, 0)).toBe(100);
    expect(rows.every((row) => Number.isInteger(row.percent))).toBe(true);
  });

  it('ranks airports, shares a rank on a tie and lists the unpublishable without one', () => {
    const candidates: AirportCandidate[] = [
      airport('DEL', [{ acoId: 'a', value: 4.6 }]),
      airport('BLR', [{ acoId: 'b', value: 4.2 }]),
      airport('MAA', [{ acoId: 'c', value: 4.2 }]),
      airport('HYD', [{ acoId: 'd', value: 3.9 }]),
      airport('CCU', []),
    ];

    const ranked = rankAirports(candidates);
    const byIata = new Map(ranked.map((row) => [row.airportIata, row]));

    expect(byIata.get('DEL')?.rank).toBe(1);
    expect(byIata.get('BLR')?.rank).toBe(2);
    expect(byIata.get('MAA')?.rank).toBe(2);
    // a shared second place means there is no third
    expect(byIata.get('HYD')?.rank).toBe(4);
    expect(byIata.get('CCU')?.rank).toBeNull();
    expect(byIata.get('CCU')?.rating).toBeNull();
  });

  it('combines two terminals at one airport, by share when one is published', () => {
    const operators = [
      { acoId: 'big', value: 4.0 },
      { acoId: 'small', value: 3.0 },
    ];

    const off = rankAirports([airport('BOM', operators)])[0];
    const on = rankAirports([
      {
        ...airport('BOM', operators),
        marketShare: { mode: 'AIRPORT_ROLLUP', sharesBp: { big: 9000, small: 1000 } },
      },
    ])[0];

    expect(off?.rating).toBe(3.5);
    expect(off?.marketShareApplied).toBe(false);
    expect(on?.rating).toBe(3.9);
    expect(on?.marketShareApplied).toBe(true);
  });

  it('describes the cohort, and says nothing at all about an empty one', () => {
    expect(cohortStatistics([])).toBeNull();
    expect(cohortStatistics([4.0, 4.4])).toEqual({
      count: 2,
      mean: 4.2,
      median: 4.2,
      p25: 4.1,
      p75: 4.3,
      min: 4,
      max: 4.4,
    });
  });
});

function airport(iata: string, operators: ReadonlyArray<{ acoId: string; value: number }>): AirportCandidate {
  return {
    airportId: `airport-${iata}`,
    airportIata: iata,
    airportName: iata,
    airportFullName: `${iata} International`,
    terminalName: 'Cargo terminal',
    terminalCount: Math.max(operators.length, 1),
    orgIds: operators.map((o) => o.acoId),
    responseCount: operators.length * 6,
    operators,
    marketShare: { mode: 'OFF', sharesBp: {} },
  };
}
