import { describe, expect, it } from 'vitest';

import { DEFAULT_MIN_COVERED_SHARE_PCT, rollupAirport } from '../../../src/modules/scoring/engine/index.js';

const three = [
  { acoId: 'a', mean: 4.5, sharePct: 50 },
  { acoId: 'b', mean: 4.0, sharePct: 30 },
  { acoId: 'c', mean: 3.5, sharePct: 20 },
];

describe('rollupAirport', () => {
  it('weights by market share: 4.5×50 + 4.0×30 + 3.5×20 = 4.15 (REQUIREMENTS §20)', () => {
    expect(rollupAirport(three)).toEqual({
      mean: 4.15,
      marketShareApplied: true,
      coveredSharePct: 100,
      operators: [
        { acoId: 'a', mean: 4.5, sharePct: 50, suppressed: false },
        { acoId: 'b', mean: 4, sharePct: 30, suppressed: false },
        { acoId: 'c', mean: 3.5, sharePct: 20, suppressed: false },
      ],
    });
  });

  it('normalises by the covered share when an operator is suppressed', () => {
    const result = rollupAirport([three[0]!, three[1]!, { acoId: 'c', mean: null, sharePct: 20 }]);
    expect(result.mean).toBe(4.31); // 345 / 80 = 4.3125
    expect(result.coveredSharePct).toBe(80);
    expect(result.marketShareApplied).toBe(true);
    expect(result.operators[2]).toEqual({ acoId: 'c', mean: null, sharePct: 20, suppressed: true });
  });

  it('withholds the airport mean when the covered share is below the threshold', () => {
    const operators = [
      { acoId: 'a', mean: null, sharePct: 50 },
      { acoId: 'b', mean: null, sharePct: 30 },
      { acoId: 'c', mean: 3.5, sharePct: 20 },
    ];
    expect(DEFAULT_MIN_COVERED_SHARE_PCT).toBe(50);
    expect(rollupAirport(operators)).toMatchObject({ mean: null, coveredSharePct: 20, marketShareApplied: true });
    expect(rollupAirport(operators, { minCoveredSharePct: 10 })).toMatchObject({ mean: 3.5, coveredSharePct: 20 });
  });

  it('publishes at exactly the threshold', () => {
    const operators = [
      { acoId: 'a', mean: 4, sharePct: 50 },
      { acoId: 'b', mean: null, sharePct: 50 },
    ];
    expect(rollupAirport(operators)).toMatchObject({ mean: 4, coveredSharePct: 50 });
  });

  it('falls back to equal weights when every share is missing or zero', () => {
    const result = rollupAirport([
      { acoId: 'a', mean: 4.5 },
      { acoId: 'b', mean: 4.0, sharePct: null },
      { acoId: 'c', mean: 3.5, sharePct: 0 },
    ]);
    expect(result.mean).toBe(4);
    expect(result.marketShareApplied).toBe(false);
    expect(result.coveredSharePct).toBe(100);
    expect(result.operators.map((operator) => operator.sharePct)).toEqual([null, null, 0]);
  });

  it('measures coverage by operator count without market share', () => {
    const operators = [
      { acoId: 'a', mean: 4.5 },
      { acoId: 'b', mean: 3.5 },
      { acoId: 'c', mean: null },
    ];
    expect(rollupAirport(operators)).toMatchObject({ mean: 4, coveredSharePct: 66.67, marketShareApplied: false });
    expect(rollupAirport([operators[0]!, { acoId: 'b', mean: null }, operators[2]!])).toMatchObject({ mean: null, coveredSharePct: 33.33 });
  });

  it('gives no weight to a scored operator without a share when others have one', () => {
    const result = rollupAirport([
      { acoId: 'a', mean: 4, sharePct: 60 },
      { acoId: 'b', mean: 1 },
    ]);
    expect(result.mean).toBe(4);
    expect(result.coveredSharePct).toBe(60);
    expect(result.operators[1]).toEqual({ acoId: 'b', mean: 1, sharePct: null, suppressed: false });
  });

  it('handles an airport without operators', () => {
    expect(rollupAirport([])).toEqual({ mean: null, marketShareApplied: false, coveredSharePct: 0, operators: [] });
  });

  it('rounds the outputs to 2 dp', () => {
    const result = rollupAirport([
      { acoId: 'a', mean: 4.333, sharePct: 33.333 },
      { acoId: 'b', mean: 3.666, sharePct: 66.667 },
    ]);
    expect(result.mean).toBe(3.89); // (4.333 × 33.333 + 3.666 × 66.667) / 100 = 3.8883…
    expect(result.coveredSharePct).toBe(100);
    expect(result.operators.map((operator) => operator.mean)).toEqual([4.33, 3.67]);
  });
});
