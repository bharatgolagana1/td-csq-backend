import { z } from 'zod';

import { idSchema } from '../../core/ids.js';

import { SCORE_LEVELS, SURVEY_TYPES } from './scores.model.js';

export const scoreLevelSchema = z.enum(SCORE_LEVELS);
export const surveyTypeSchema = z.enum(SURVEY_TYPES);

const meanWithN = z.object({ mean: z.number().nullable(), n: z.number() });

export const scoreRowResponse = z.object({
  level: scoreLevelSchema,
  /** Stable code of the node (question / subcategory / category code), or `OVERALL`. */
  refId: z.string(),
  customer: meanWithN.extend({ naCount: z.number(), byType: z.object({ FF: meanWithN, CB: meanWithN }) }),
  self: meanWithN,
  suppressed: z.literal('INSUFFICIENT_RESPONSES').optional(),
  /** OVERALL row only: dense rank among the cycle's operators with a score. */
  rank: z.number().nullable().optional(),
  rankOf: z.number().optional(),
  previous: z.object({ cycleId: z.string(), mean: z.number().nullable() }).optional(),
  delta: z.number().optional(),
});
export type ScoreRowDto = z.infer<typeof scoreRowResponse>;

export const distributionBucketResponse = z.object({
  rating: z.number().nullable(),
  label: z.enum(['Excellent', 'Very Good', 'Good', 'Fair', 'Poor', 'NA']),
  count: z.number(),
  pct: z.number(),
});

export const responseCountsResponse = z.object({ customer: z.number(), self: z.number(), FF: z.number(), CB: z.number() });

/** `getScores(cycleId, acoId, surveyType)`: the operator's rows in tree order plus the feedback distribution and counts. */
export const scoreSetResponse = z.object({
  cycleId: z.string(),
  acoId: z.string(),
  surveyType: surveyTypeSchema,
  /** Null until the cycle has been scored for this operator and type. */
  surveyId: z.string().nullable(),
  provisional: z.boolean().nullable(),
  computedAt: z.string().nullable(),
  rows: z.array(scoreRowResponse),
  distribution: z.array(distributionBucketResponse),
  counts: responseCountsResponse,
});
export type ScoreSetDto = z.infer<typeof scoreSetResponse>;

export const airportScoreResponse = z.object({
  cycleId: z.string(),
  airportId: z.string(),
  surveyType: surveyTypeSchema,
  level: scoreLevelSchema,
  refId: z.string(),
  mean: z.number().nullable(),
  marketShareApplied: z.boolean(),
  coveredSharePct: z.number(),
  operators: z.array(z.object({ acoId: z.string(), mean: z.number().nullable(), sharePct: z.number().nullable(), suppressed: z.boolean() })),
  rank: z.number().nullable(),
  rankOf: z.number(),
  provisional: z.boolean(),
  computedAt: z.string(),
});
export type AirportScoreDto = z.infer<typeof airportScoreResponse>;

/** One line of the national table: airport ratings and ranks only, never an operator's figures (§7 "Confidentiality"). */
export const nationalRowResponse = z.object({
  airportId: z.string(),
  iata: z.string(),
  name: z.string(),
  mean: z.number().nullable(),
  rank: z.number().nullable(),
  rankOf: z.number(),
  marketShareApplied: z.boolean(),
  coveredSharePct: z.number(),
  provisional: z.boolean(),
  computedAt: z.string(),
});
export type NationalRowDto = z.infer<typeof nationalRowResponse>;

// --- POST /scoring/cycles/:cycleId/run ----------------------------------------

export const runParams = z.object({ cycleId: idSchema });

export const runBody = z
  .object({
    /** Force a provisional run; a run while the assessment is open is provisional regardless. */
    provisional: z.boolean().optional(),
  })
  .strict()
  .optional();
export type RunInput = z.infer<typeof runBody>;

export const runSummaryResponse = z.object({
  cycleId: z.string(),
  provisional: z.boolean(),
  computedAt: z.string(),
  surveyTypes: z.array(surveyTypeSchema),
  operators: z.number(),
  airports: z.number(),
  rows: z.number(),
  airportRows: z.number(),
});
export type RunSummaryDto = z.infer<typeof runSummaryResponse>;
