// Shaping shared by the report builders: score rows → wire figures, summaries
// of cycles / operators, and the cycle-state flags the payloads carry.
import { cycleSurveyTypes } from '../cycles/domain/participants.js';
import { round2, roundHalfUp, rowKey } from '../scoring/engine/index.js';

import type { CycleSummaryDto, LevelFiguresDto, MeanWithNDto, OperatorSummaryDto, SurveyType } from './reports.schemas.js';
import type { AirportView, CycleView, CycleType, OperatorView, ScoreLevel, ScoreRowView } from './reports.sources.js';

export { round2, roundHalfUp };

const FINAL_STATUSES = new Set(['SCORED', 'ARCHIVED']);
const LIVE_STATUSES = new Set(['PUBLISHED', 'SAMPLING_OPEN', 'SAMPLING_CLOSED', 'ASSESSMENT_OPEN', 'ASSESSMENT_CLOSED']);

/** A SCORED (or archived after scoring) cycle carries final figures. */
export function isScored(cycle: Pick<CycleView, 'status'>): boolean {
  return FINAL_STATUSES.has(cycle.status);
}

/** A published cycle that has not been scored yet: its figures come from provisional runs. */
export function isLive(cycle: Pick<CycleView, 'status'>): boolean {
  return LIVE_STATUSES.has(cycle.status);
}

export function surveyTypesOfCycle(type: CycleType): SurveyType[] {
  return cycleSurveyTypes(type);
}

export function cycleSummaryOf(cycle: CycleView): CycleSummaryDto {
  return {
    id: cycle.id,
    code: cycle.code,
    name: cycle.name,
    type: cycle.type,
    status: cycle.status,
    assessment: cycle.assessment ? { start: cycle.assessment.start.toISOString(), end: cycle.assessment.end.toISOString() } : null,
    scoredAt: cycle.scoredAt?.toISOString() ?? null,
  };
}

export function operatorSummaryOf(operator: OperatorView, airport: AirportView | null): OperatorSummaryDto {
  return {
    id: operator.id,
    code: operator.code,
    name: operator.name,
    airport: airport ? { id: airport.id, iata: airport.iata, name: airport.name } : null,
  };
}

export const NO_SCORE: MeanWithNDto = { mean: null, n: 0 };

/** Score rows keyed by `level:refId` (the engine's `rowKey`). */
export function indexRows(rows: readonly ScoreRowView[]): Map<string, ScoreRowView> {
  return new Map(rows.map((row) => [rowKey(row), row]));
}

export function rowAt(index: Map<string, ScoreRowView>, level: ScoreLevel, refId: string): ScoreRowView | undefined {
  return index.get(rowKey({ level, refId }));
}

function meanWithN(figure: { mean: number | null; n: number } | undefined): MeanWithNDto {
  return figure ? { mean: round2(figure.mean), n: figure.n } : NO_SCORE;
}

/** The wire figures of one level; a missing row (not scored yet) is an empty figure, never an error. */
export function levelFiguresOf(row: ScoreRowView | undefined): LevelFiguresDto {
  return {
    customer: meanWithN(row?.customer),
    self: { mean: round2(row?.self.mean ?? null) },
    previous: round2(row?.previous?.mean ?? null),
    delta: round2(row?.delta ?? null),
    ...(row?.suppressed ? { suppressed: row.suppressed } : {}),
  };
}

export function byTypeOf(row: ScoreRowView | undefined): { FF: MeanWithNDto; CB: MeanWithNDto } {
  return { FF: meanWithN(row?.customer.byType.FF), CB: meanWithN(row?.customer.byType.CB) };
}

/** Equal-weight mean of the known values, 2 dp, with how many contributed. */
export function averageOf(values: readonly (number | null)[]): MeanWithNDto {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return NO_SCORE;
  return { mean: roundHalfUp(known.reduce((sum, value) => sum + value, 0) / known.length, 2), n: known.length };
}

export function percentage(part: number, whole: number): number {
  return whole <= 0 ? 0 : roundHalfUp((part / whole) * 100, 2);
}
