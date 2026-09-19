import type { AnyBulkWriteOperation } from 'mongoose';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { newId } from '../../kernel/ids.js';
import { AirportModel, type AirportDoc, type RosterEntry } from './refdata.models.js';
import type { AirportInput, OperatorRosterEntry } from './refdata.contracts.js';

/**
 * Airports are reference data every organisation reads and only ACFI staff
 * write. The operator roster is deliberately absent from the view an operator
 * sees: who else handles cargo at an airport, and which of them pay for CSQ, is
 * commercial information ACFI holds rather than publishes.
 */

export interface AirportView {
  id: string;
  iataCode: string;
  icaoCode: string | null;
  name: string;
  city: string | null;
  country: string;
  region: string;
  latitude: number;
  longitude: number;
  timezone: string;
  isActive: boolean;
}

export interface AirportPlatformView extends AirportView {
  operatorRoster: RosterEntry[];
  source: { dataset: string; ident: string } | null;
  updatedAt: string;
}

function coordinates(doc: AirportDoc): { latitude: number; longitude: number } {
  // GeoJSON orders a position longitude first, which is the opposite of how
  // every airport table prints it. Converted once, here.
  const [longitude, latitude] = doc.location.coordinates;
  return { latitude, longitude };
}

function toView(doc: AirportDoc): AirportView {
  const { latitude, longitude } = coordinates(doc);
  return {
    id: doc._id,
    iataCode: doc.iataCode,
    icaoCode: doc.icaoCode,
    name: doc.name,
    city: doc.city,
    country: doc.country,
    region: doc.region,
    latitude,
    longitude,
    timezone: doc.timezone,
    isActive: doc.isActive,
  };
}

function toPlatformView(doc: AirportDoc): AirportPlatformView {
  return {
    ...toView(doc),
    operatorRoster: doc.operatorRoster.map((entry) => ({ ...entry })),
    source: doc.source ? { ...doc.source } : null,
    updatedAt: (doc.updatedAt ?? new Date()).toISOString(),
  };
}

function toDocumentFields(input: AirportInput): Omit<AirportDoc, '_id' | 'operatorRoster' | 'updatedAt' | 'source'> {
  return {
    iataCode: input.iataCode,
    icaoCode: input.icaoCode,
    name: input.name,
    city: input.city,
    country: input.country,
    region: input.region,
    location: { type: 'Point', coordinates: [input.longitude, input.latitude] },
    timezone: input.timezone,
    isActive: input.isActive,
  };
}

export interface AirportListQuery {
  q?: string | undefined;
  country?: string | undefined;
  region?: string | undefined;
  includeInactive: boolean;
  limit: number;
}

export interface AirportPage {
  items: AirportView[];
  /** True when the limit cut the answer short, so a caller is never silently capped. */
  hasMore: boolean;
}

export async function listAirports(query: AirportListQuery): Promise<AirportPage> {
  const filter: Record<string, unknown> = {};
  if (!query.includeInactive) filter['isActive'] = true;
  if (query.country) filter['country'] = query.country;
  if (query.region) filter['region'] = query.region;
  if (query.q) {
    // the search box is a filter over a 116 row reference table, not a text
    // search engine; the term is escaped so a stray bracket cannot throw
    const term = new RegExp(escapeRegExp(query.q), 'i');
    filter['$or'] = [{ name: term }, { city: term }, { iataCode: term }, { icaoCode: term }];
  }
  // one more than asked for, so a truncated answer says so rather than looking
  // like the whole reference table
  const rows = await AirportModel.find(filter).sort({ iataCode: 1 }).limit(query.limit + 1).lean().exec();
  return { items: rows.slice(0, query.limit).map(toView), hasMore: rows.length > query.limit };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getAirport(iataCode: string): Promise<AirportView> {
  return toView(await requireAirport(iataCode));
}

export async function getAirportForPlatform(iataCode: string): Promise<AirportPlatformView> {
  return toPlatformView(await requireAirport(iataCode));
}

export async function requireAirport(iataCode: string): Promise<AirportDoc> {
  const doc = await AirportModel.findOne({ iataCode }).lean().exec();
  if (!doc) throw notFound('No such airport');
  return doc;
}

export async function createAirport(input: AirportInput): Promise<AirportView> {
  const existing = await AirportModel.findOne({ iataCode: input.iataCode }).lean().exec();
  if (existing) throw conflict(`${input.iataCode} already exists`);

  await assertIcaoFree([input]);
  const created = await AirportModel.create({ ...toDocumentFields(input), source: null });
  return toView(created.toObject());
}

export async function patchAirport(
  iataCode: string,
  patch: Partial<Omit<AirportInput, 'iataCode'>>,
): Promise<AirportView> {
  const current = await requireAirport(iataCode);

  const assignments: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'latitude' || key === 'longitude') continue;
    assignments[key] = value;
  }
  if (patch.latitude !== undefined || patch.longitude !== undefined) {
    const { latitude, longitude } = coordinates(current);
    assignments['location'] = {
      type: 'Point',
      coordinates: [patch.longitude ?? longitude, patch.latitude ?? latitude],
    };
  }
  if (patch.icaoCode !== undefined && patch.icaoCode !== null) {
    await assertIcaoFree([{ iataCode, icaoCode: patch.icaoCode }]);
  }

  const updated = await AirportModel.findOneAndUpdate({ iataCode }, { $set: assignments }, { new: true })
    .lean()
    .exec();
  if (!updated) throw notFound('No such airport');
  return toView(updated);
}

export interface BulkOutcome {
  rows: number;
  /** Airports the file introduced. */
  created: number;
  /** Airports that already existed and were restated by the file. */
  updated: number;
  dryRun: boolean;
}

/**
 * Bulk upload. Every row is validated before any row is written, and one bad
 * row refuses the whole file: applying the good half leaves an administrator
 * guessing which half landed, and the file they fix and re-upload then has to
 * be safe to apply twice. It is, because rows are keyed by IATA code and the
 * write is an upsert, so a re-upload converges rather than duplicating.
 *
 * Nothing is repaired on the way in. A lower case code, a swapped latitude, a
 * zone spelled Asia/Calcutta: each is reported with its row number and the file
 * is refused, because a file that needed one repair has not been checked for
 * the errors that repair would hide.
 */
export async function bulkUpsertAirports(
  rows: readonly AirportInput[],
  options: { dryRun: boolean; source?: { dataset: string } },
): Promise<BulkOutcome> {
  const problems: Array<{ path: string; message: string }> = [];

  const seenIata = new Map<string, number>();
  const seenIcao = new Map<string, number>();
  rows.forEach((row, index) => {
    const firstIata = seenIata.get(row.iataCode);
    if (firstIata !== undefined) {
      problems.push({ path: `rows.${index}.iataCode`, message: `${row.iataCode} also appears on row ${firstIata}` });
    } else {
      seenIata.set(row.iataCode, index);
    }

    if (row.icaoCode !== null) {
      const firstIcao = seenIcao.get(row.icaoCode);
      if (firstIcao !== undefined) {
        problems.push({ path: `rows.${index}.icaoCode`, message: `${row.icaoCode} also appears on row ${firstIcao}` });
      } else {
        seenIcao.set(row.icaoCode, index);
      }
    }
  });

  problems.push(...(await icaoConflicts(rows)));

  if (problems.length > 0) {
    throw fail('VALIDATION_FAILED', `${problems.length} problems in the upload. Nothing was written.`, problems);
  }

  if (options.dryRun) {
    const existing = await AirportModel.countDocuments({ iataCode: { $in: [...seenIata.keys()] } }).exec();
    return { rows: rows.length, created: rows.length - existing, updated: existing, dryRun: true };
  }

  const operations: Array<AnyBulkWriteOperation<AirportDoc>> = rows.map((row) => ({
    updateOne: {
      filter: { iataCode: row.iataCode },
      update: {
        $set: {
          ...toDocumentFields(row),
          ...(options.source ? { source: { dataset: options.source.dataset, ident: row.iataCode } } : {}),
        },
        // _id and the roster belong to the airport, not to the file: an upload
        // that re-states an airport must not wipe who operates there
        $setOnInsert: { _id: newId(), operatorRoster: [] },
      },
      upsert: true,
    },
  }));

  const result = await AirportModel.bulkWrite(operations, { ordered: false });
  // matched rather than modified: a restated row still bumps updatedAt, so
  // modifiedCount would report the whole file as changed on every upload
  return {
    rows: rows.length,
    created: result.upsertedCount,
    updated: result.matchedCount,
    dryRun: false,
  };
}

async function icaoConflicts(
  rows: ReadonlyArray<{ iataCode: string; icaoCode: string | null }>,
): Promise<Array<{ path: string; message: string }>> {
  const codes = rows.map((row) => row.icaoCode).filter((code): code is string => code !== null);
  if (codes.length === 0) return [];

  const clashes = await AirportModel.find({ icaoCode: { $in: codes } })
    .select('iataCode icaoCode')
    .lean()
    .exec();
  const ownerByIcao = new Map(clashes.map((row) => [row.icaoCode, row.iataCode]));

  const problems: Array<{ path: string; message: string }> = [];
  rows.forEach((row, index) => {
    if (row.icaoCode === null) return;
    const owner = ownerByIcao.get(row.icaoCode);
    if (owner !== undefined && owner !== row.iataCode) {
      problems.push({ path: `rows.${index}.icaoCode`, message: `${row.icaoCode} already belongs to ${owner}` });
    }
  });
  return problems;
}

async function assertIcaoFree(rows: ReadonlyArray<{ iataCode: string; icaoCode: string | null }>): Promise<void> {
  const problems = await icaoConflicts(rows);
  if (problems.length > 0) throw conflict(problems[0]?.message ?? 'ICAO code already in use');
}

/**
 * The roster is replaced wholesale rather than patched entry by entry, because
 * market share is derived from how many operators are on it: adding one without
 * restating the rest is how an airport ends up with two operators recorded and
 * a single share of 100 percent still standing.
 */
export async function replaceOperatorRoster(
  iataCode: string,
  operators: readonly OperatorRosterEntry[],
): Promise<AirportPlatformView> {
  const problems: Array<{ path: string; message: string }> = [];

  const keys = new Set<string>();
  const orgIds = new Set<string>();
  operators.forEach((operator, index) => {
    if (keys.has(operator.operatorKey)) {
      problems.push({ path: `operators.${index}.operatorKey`, message: `${operator.operatorKey} appears twice` });
    }
    keys.add(operator.operatorKey);

    if (operator.orgId !== null) {
      if (orgIds.has(operator.orgId)) {
        problems.push({
          path: `operators.${index}.orgId`,
          message: 'one organisation cannot be two operators at the same airport',
        });
      }
      orgIds.add(operator.orgId);
    }
  });
  if (problems.length > 0) throw fail('VALIDATION_FAILED', 'The roster is not consistent', problems);

  const updated = await AirportModel.findOneAndUpdate(
    { iataCode },
    { $set: { operatorRoster: operators.map((operator) => ({ ...operator })) } },
    { new: true },
  )
    .lean()
    .exec();
  if (!updated) throw notFound('No such airport');
  return toPlatformView(updated);
}
