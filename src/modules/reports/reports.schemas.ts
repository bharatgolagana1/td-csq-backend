import { z } from 'zod';

import { idSchema } from '../../core/ids.js';

export const SURVEY_TYPES = ['DOMESTIC', 'INTERNATIONAL'] as const;
export const surveyTypeSchema = z.enum(SURVEY_TYPES);
export type SurveyType = z.infer<typeof surveyTypeSchema>;

export const CYCLE_TYPES = ['DOMESTIC', 'INTERNATIONAL', 'BOTH'] as const;

/** Every mean on the wire is 2 dp or `null` (no score / suppressed). */
const mean = z.number().nullable();

export const meanWithN = z.object({ mean, n: z.number() });
export type MeanWithNDto = z.infer<typeof meanWithN>;

export const selfFigure = z.object({ mean });

const suppressed = z.literal('INSUFFICIENT_RESPONSES').optional();

export const cycleSummary = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.enum(CYCLE_TYPES),
  status: z.string(),
  /** Assessment window as ISO instants; the dashboard's "cycle strip". */
  assessment: z.object({ start: z.string(), end: z.string() }).nullable(),
  scoredAt: z.string().nullable(),
});
export type CycleSummaryDto = z.infer<typeof cycleSummary>;

export const airportSummary = z.object({ id: z.string(), iata: z.string(), name: z.string() });
export type AirportSummaryDto = z.infer<typeof airportSummary>;

export const operatorSummary = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  airport: airportSummary.nullable(),
});
export type OperatorSummaryDto = z.infer<typeof operatorSummary>;

/** Figures of one survey level (category / subcategory / question) for one operator. */
export const levelFigures = z.object({
  customer: meanWithN,
  self: selfFigure,
  /** The customer mean of the previous SCORED cycle of the same type, when the ref existed there. */
  previous: mean,
  /** `customer.mean − previous`, 2 dp; only when both are known. */
  delta: mean,
  suppressed,
});
export type LevelFiguresDto = z.infer<typeof levelFigures>;

const surveyNode = z.object({ id: z.string(), code: z.string(), name: z.string() });

export const subcategoryReport = surveyNode.extend(levelFigures.shape);
export const categoryReport = surveyNode.extend({ ...levelFigures.shape, subcategories: z.array(subcategoryReport) });
export type CategoryReportDto = z.infer<typeof categoryReport>;

const comparisonPoint = z.object({ cycleId: z.string(), cycleName: z.string(), customer: mean, self: mean });

export const feedbackBucket = z.object({
  rating: z.number().nullable(),
  label: z.string(),
  count: z.number(),
  pct: z.number(),
});

export const assessorStats = z.object({
  total: z.number(),
  completed: z.number(),
  inProgress: z.number(),
  yetToStart: z.number(),
});
export type AssessorStatsDto = z.infer<typeof assessorStats>;

/** SUBMITTED assessments behind the report: customers plus the operator's own self-assessment. */
export const assessmentCounts = z.object({ total: z.number(), customer: z.number(), self: z.number() });
export type AssessmentCountsDto = z.infer<typeof assessmentCounts>;

/** What an operator sees of the country: airport ratings and ranks, never another operator's figures. */
export const nationalTableRow = z.object({
  airportIata: z.string(),
  airportName: z.string(),
  rating: mean,
  rank: z.number().nullable(),
  /** Airports with a figure in this table. */
  rankOf: z.number(),
  /** True on the airport the operator works at. */
  isOwn: z.boolean(),
});
export type NationalTableRowDto = z.infer<typeof nationalTableRow>;

// --- GET /reports/operator/:acoId ------------------------------------------

export const operatorReportQuery = z.object({
  cycleId: idSchema.optional(),
  surveyType: surveyTypeSchema.optional(),
});
export type OperatorReportQuery = z.infer<typeof operatorReportQuery>;

export const operatorReportResponse = z.object({
  cycle: cycleSummary,
  surveyType: surveyTypeSchema,
  /** True while the cycle is not SCORED: the figures come from a nightly (or manual) provisional run. */
  provisional: z.boolean(),
  operator: operatorSummary,
  overall: z.object({
    customer: meanWithN,
    self: selfFigure,
    rank: z.number().nullable(),
    rankOf: z.number(),
    suppressed,
  }),
  comparison: z.object({ current: comparisonPoint, previous: comparisonPoint.nullable() }),
  feedbackDistribution: z.array(feedbackBucket),
  categories: z.array(categoryReport),
  byStakeholder: z.object({ FF: meanWithN, CB: meanWithN }),
  assessorStats,
  assessments: assessmentCounts,
  nationalTable: z.array(nationalTableRow),
  /** Airports live on the platform (active, i.e. Phase I), whether or not they are in the table. */
  airportsTotal: z.number(),
});
export type OperatorReportDto = z.infer<typeof operatorReportResponse>;

// --- GET /reports/operator/:acoId/questions --------------------------------

export const questionReportRow = z.object({
  id: z.string(),
  code: z.string(),
  text: z.string(),
  category: z.object({ code: z.string(), name: z.string() }),
  subcategory: z.object({ code: z.string(), name: z.string() }).nullable(),
  customer: meanWithN.extend({ naCount: z.number() }),
  self: selfFigure,
  previous: mean,
  delta: mean,
  suppressed,
  /** Customer answers to this question that carry a comment. */
  comments: z.number(),
});
export type QuestionReportRowDto = z.infer<typeof questionReportRow>;

export const operatorQuestionsResponse = z.object({
  cycle: cycleSummary,
  surveyType: surveyTypeSchema,
  provisional: z.boolean(),
  operator: operatorSummary,
  questions: z.array(questionReportRow),
});
export type OperatorQuestionsDto = z.infer<typeof operatorQuestionsResponse>;

// --- GET /reports/airport/:airportId ---------------------------------------

export const airportReportQuery = operatorReportQuery;
export type AirportReportQuery = z.infer<typeof airportReportQuery>;

const airportLevel = z.object({
  mean,
  /** Share of the airport (or, without a snapshot, of its operators) behind the figure. */
  coveredSharePct: z.number(),
  marketShareApplied: z.boolean(),
});

export const airportOperatorRow = z.object({
  acoId: z.string(),
  code: z.string(),
  name: z.string(),
  mean,
  sharePct: mean,
  suppressed: z.boolean(),
});
export type AirportOperatorRowDto = z.infer<typeof airportOperatorRow>;

export const airportReportResponse = z.object({
  cycle: cycleSummary,
  surveyType: surveyTypeSchema,
  provisional: z.boolean(),
  airport: airportSummary,
  overall: airportLevel.extend({ rank: z.number().nullable(), rankOf: z.number() }),
  /** Present for PLATFORM and AIRPORT callers only. */
  operators: z.array(airportOperatorRow).optional(),
  categories: z.array(surveyNode.extend(airportLevel.shape)),
});
export type AirportReportDto = z.infer<typeof airportReportResponse>;

// --- GET /reports/national -------------------------------------------------

export const nationalReportQuery = operatorReportQuery;
export type NationalReportQuery = z.infer<typeof nationalReportQuery>;

export const nationalReportResponse = z.object({
  cycle: cycleSummary,
  surveyType: surveyTypeSchema,
  provisional: z.boolean(),
  airports: z.array(
    airportSummary.extend({
      rating: mean,
      rank: z.number().nullable(),
      rankOf: z.number(),
      coveredSharePct: z.number(),
      marketShareApplied: z.boolean(),
    }),
  ),
  operators: z.array(
    z.object({
      acoId: z.string(),
      code: z.string(),
      name: z.string(),
      airport: airportSummary.nullable(),
      rating: mean,
      n: z.number(),
      rank: z.number().nullable(),
      rankOf: z.number(),
      suppressed,
    }),
  ),
  /** Equal-weight average of the operators' published category means; `n` = operators contributing. */
  categories: z.array(surveyNode.extend({ mean, n: z.number() })),
  participation: z.object({
    airports: z.number(),
    operators: z.number(),
    sampleLocked: z.number(),
    invited: z.number(),
    started: z.number(),
    completed: z.number(),
    pending: z.number(),
    /** completed / invited × 100, 2 dp; 0 when nothing was invited. */
    completionRate: z.number(),
  }),
});
export type NationalReportDto = z.infer<typeof nationalReportResponse>;

// --- GET /reports/comparison -----------------------------------------------

export const MAX_COMPARED_CYCLES = 6;

export const comparisonQuery = z.object({
  acoId: idSchema,
  cycleIds: z
    .string()
    .transform((value) => [...new Set(value.split(',').map((part) => part.trim()).filter((part) => part !== ''))])
    .pipe(z.array(idSchema).min(1).max(MAX_COMPARED_CYCLES)),
  surveyType: surveyTypeSchema.optional(),
});
export type ComparisonQuery = z.infer<typeof comparisonQuery>;

const comparisonValue = z.object({
  cycleId: z.string(),
  customer: meanWithN,
  self: selfFigure,
  suppressed,
});

/** One survey node across the compared cycles; `values` is aligned with `cycles`. Matched on code, not id. */
const comparisonRow = z.object({
  code: z.string(),
  name: z.string(),
  /** The category code of a subcategory / question row, the subcategory code of a question under one. */
  parentCode: z.string().nullable(),
  values: z.array(comparisonValue),
});
export type ComparisonRowDto = z.infer<typeof comparisonRow>;

export const comparisonResponse = z.object({
  operator: operatorSummary,
  surveyType: surveyTypeSchema,
  cycles: z.array(cycleSummary.extend({ provisional: z.boolean() })),
  overall: z.array(comparisonValue.extend({ rank: z.number().nullable(), rankOf: z.number() })),
  categories: z.array(comparisonRow),
  subcategories: z.array(comparisonRow),
  questions: z.array(comparisonRow),
});
export type ComparisonDto = z.infer<typeof comparisonResponse>;

// --- GET /reports/export ---------------------------------------------------

export const EXPORT_SCOPES = ['operator', 'airport', 'national'] as const;

export const exportQuery = z.object({
  scope: z.enum(EXPORT_SCOPES),
  cycleId: idSchema.optional(),
  surveyType: surveyTypeSchema.optional(),
  acoId: idSchema.optional(),
  airportId: idSchema.optional(),
  format: z.enum(['csv']).default('csv'),
});
export type ExportQuery = z.infer<typeof exportQuery>;
