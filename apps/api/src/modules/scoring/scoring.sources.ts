import mongoose from 'mongoose';
import type { z } from 'zod';
import type { FormScope } from '@csq/contracts';
import { fail } from '../../kernel/errors.js';
import { currentScope } from '../../kernel/requestContext.js';
import {
  AirportInput,
  AssessmentInput,
  CategoryInput,
  CycleInput,
  INPUT_COLLECTIONS,
  InstrumentInput,
  MarketShareSnapshotInput,
  OrganisationInput,
  PUBLISHED_PROFILE_STATE,
  ParticipationInput,
  SUBMITTED_ASSESSMENT_STATE,
  WITHDRAWN_PARTICIPATION_STATE,
  WeightingProfileInput,
  type ScoringSources,
} from './scoring.inputs.js';

/**
 * The Mongo implementation of the scoring inputs.
 *
 * A scoring run ranks a cohort, so it reads across organisations by definition.
 * That is only legitimate inside an explicitly recorded system scope, and every
 * read here refuses to run in any other, which keeps "tenancy is enforced
 * centrally" true: the one place that steps outside it says so in the audit log
 * before it starts, and cannot be reached from a request that did not.
 */

function requireSystemScope(what: string): void {
  const scope = currentScope();
  if (scope.kind !== 'SYSTEM') {
    throw fail(
      'INTERNAL',
      `${what} reads across organisations and must run inside runSystem with a recorded reason`,
    );
  }
}

/** A malformed upstream document is a loud failure naming the field, never a wrong score. */
function parseRow<T extends z.ZodTypeAny>(schema: T, row: unknown, collection: string): z.infer<T> {
  const result = schema.safeParse(row);
  if (!result.success) {
    const where = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw fail('INTERNAL', `A document in ${collection} does not match what scoring reads. ${where}`);
  }
  return result.data;
}

interface ReadOptions {
  readonly sort?: Record<string, 1 | -1>;
  readonly limit?: number;
}

async function readMany(
  collection: string,
  filter: Record<string, unknown>,
  options: ReadOptions = {},
): Promise<unknown[]> {
  let cursor = mongoose.connection.collection(collection).find(filter);
  if (options.sort) cursor = cursor.sort(options.sort);
  if (options.limit !== undefined) cursor = cursor.limit(options.limit);
  return cursor.toArray();
}

async function readOne(collection: string, filter: Record<string, unknown>): Promise<unknown> {
  return mongoose.connection.collection(collection).findOne(filter);
}

function indexById<T extends { _id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row._id, row]));
}

export function createMongoSources(): ScoringSources {
  return {
    async cycle(cycleId) {
      requireSystemScope('Reading a cycle for scoring');
      const row = await readOne(INPUT_COLLECTIONS.cycles, { _id: cycleId });
      return row === null ? null : parseRow(CycleInput, row, INPUT_COLLECTIONS.cycles);
    },

    async participations(cycleId) {
      requireSystemScope('Reading the participations of a cycle');
      const rows = await readMany(INPUT_COLLECTIONS.participations, {
        cycleId,
        // a withdrawn operator is not in the cohort and must not be ranked in it
        state: { $ne: WITHDRAWN_PARTICIPATION_STATE },
      });
      return rows.map((row) => parseRow(ParticipationInput, row, INPUT_COLLECTIONS.participations));
    },

    async submittedAssessments(cycleId, acoOrgId) {
      requireSystemScope('Reading submitted assessments');
      const rows = await readMany(INPUT_COLLECTIONS.assessments, {
        cycleId,
        acoOrgId,
        state: SUBMITTED_ASSESSMENT_STATE,
      });
      return rows.map((row) => parseRow(AssessmentInput, row, INPUT_COLLECTIONS.assessments));
    },

    async instruments(instrumentIds) {
      requireSystemScope('Reading the instruments a cycle was answered against');
      const wanted = [...new Set(instrumentIds)];
      if (wanted.length === 0) return new Map();
      const rows = await readMany(INPUT_COLLECTIONS.instruments, { _id: { $in: wanted } });
      return indexById(
        rows.map((row) => parseRow(InstrumentInput, row, INPUT_COLLECTIONS.instruments)),
      );
    },

    async latestInstrument(formScope: FormScope) {
      requireSystemScope('Reading the published instrument');
      const rows = await readMany(
        INPUT_COLLECTIONS.instruments,
        { formScope },
        { sort: { version: -1 }, limit: 1 },
      );
      const row = rows[0];
      return row === undefined
        ? null
        : parseRow(InstrumentInput, row, INPUT_COLLECTIONS.instruments);
    },

    async publishedProfiles() {
      requireSystemScope('Reading the published weighting profiles');
      const rows = await readMany(INPUT_COLLECTIONS.weightingProfiles, {
        state: PUBLISHED_PROFILE_STATE,
      });
      return rows.map((row) =>
        parseRow(WeightingProfileInput, row, INPUT_COLLECTIONS.weightingProfiles),
      );
    },

    async categories() {
      requireSystemScope('Reading category names');
      const rows = await readMany(INPUT_COLLECTIONS.categories, {});
      const out = new Map<string, CategoryInput>();
      for (const row of rows) {
        const category = parseRow(CategoryInput, row, INPUT_COLLECTIONS.categories);
        out.set(category.code, category);
      }
      return out;
    },

    async airports(airportIds) {
      requireSystemScope('Reading airport reference data');
      const wanted = [...new Set(airportIds)];
      if (wanted.length === 0) return new Map();
      const rows = await readMany(INPUT_COLLECTIONS.airports, { _id: { $in: wanted } });
      return indexById(rows.map((row) => parseRow(AirportInput, row, INPUT_COLLECTIONS.airports)));
    },

    async marketShares(airportIds) {
      requireSystemScope('Reading published market shares');
      const wanted = [...new Set(airportIds)];
      if (wanted.length === 0) return new Map();

      const rows = await readMany(
        INPUT_COLLECTIONS.marketShares,
        { airportId: { $in: wanted } },
        { sort: { effectiveFrom: -1 } },
      );

      const out = new Map<string, MarketShareSnapshotInput>();
      for (const row of rows) {
        const snapshot = parseRow(MarketShareSnapshotInput, row, INPUT_COLLECTIONS.marketShares);
        // sorted newest first, so the first one seen for an airport is the one
        // in force and the rest are history
        if (!out.has(snapshot.airportId)) out.set(snapshot.airportId, snapshot);
      }
      return out;
    },

    async organisations(orgIds) {
      requireSystemScope('Reading operator names');
      const wanted = [...new Set(orgIds)];
      if (wanted.length === 0) return new Map();
      const rows = await readMany(INPUT_COLLECTIONS.organisations, { _id: { $in: wanted } });
      return indexById(
        rows.map((row) => parseRow(OrganisationInput, row, INPUT_COLLECTIONS.organisations)),
      );
    },
  };
}
