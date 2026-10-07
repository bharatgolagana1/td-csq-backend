import { readFile } from 'node:fs/promises';

import type { FilterQuery, Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';
import { idString, toId } from '../../core/ids.js';
import { pageOf, parseSort, searchFilter, skipLimit, type Page } from '../../core/pagination.js';
import { audit } from '../audit/audit.service.js';

import { parseAirportsCsv, type AirportRow } from './airports.csv.js';
import { AirportModel, type AirportDoc } from './airports.model.js';
import { PHASE_I_IATA, regionForState } from './airports.regions.js';
import type { AirportDto, AirportListQuery, CreateAirportInput, ImportResultDto, PatchAirportInput } from './airports.schemas.js';

export function toAirportDto(doc: AirportDoc): AirportDto {
  return {
    id: idString(doc._id),
    iata: doc.iata,
    icao: doc.icao,
    name: doc.name,
    city: doc.city,
    state: doc.state,
    region: doc.region,
    country: doc.country,
    lat: doc.lat,
    lng: doc.lng,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

const SORTABLE = ['iata', 'name', 'city', 'state', 'region', 'active', 'createdAt'] as const;

/** Reference data: no tenancy filter, every signed-in role with `airports.view` sees the same list. */
export async function listAirports(query: AirportListQuery): Promise<Page<AirportDto>> {
  const filter: FilterQuery<AirportDoc> = searchFilter<AirportDoc>(query.q, ['iata', 'icao', 'name', 'city']);
  if (query.active !== undefined) filter.active = query.active;
  if (query.region) filter.region = query.region;
  if (query.state) filter.state = query.state;
  const sort = parseSort(query.sort, SORTABLE, 'iata');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    AirportModel.find(filter).sort(sort).skip(skip).limit(limit).lean<AirportDoc[]>(),
    AirportModel.countDocuments(filter),
  ]);
  return pageOf(docs.map(toAirportDto), total, query);
}

export async function findAirportById(id: string | Types.ObjectId): Promise<AirportDoc | null> {
  return AirportModel.findById(toId(idString(id), 'airportId')).lean<AirportDoc>();
}

export async function findAirportsByIds(ids: Iterable<string | Types.ObjectId>): Promise<Map<string, AirportDoc>> {
  const unique = [...new Set([...ids].map(idString))];
  if (unique.length === 0) return new Map();
  const docs = await AirportModel.find({ _id: { $in: unique.map((id) => toId(id)) } }).lean<AirportDoc[]>();
  return new Map(docs.map((doc) => [idString(doc._id), doc]));
}

export async function findAirportByIata(iata: string): Promise<AirportDoc | null> {
  return AirportModel.findOne({ iata: iata.trim().toUpperCase() }).lean<AirportDoc>();
}

export async function getAirport(id: string): Promise<AirportDto> {
  const doc = await findAirportById(id);
  if (!doc) throw new AppError('NOT_FOUND', 'Airport not found');
  return toAirportDto(doc);
}

/** VALIDATION (the airport is an input of another record) rather than 404. */
export async function requireAirport(id: string): Promise<AirportDoc> {
  const doc = await findAirportById(id);
  if (!doc) throw new AppError('VALIDATION', 'Unknown airport', { airportId: id });
  return doc;
}

function resolveRegion(state: string, region: string | undefined): string {
  const resolved = region ?? regionForState(state);
  if (resolved === null) throw new AppError('VALIDATION', `No region known for state "${state}"; supply one`, { state });
  return resolved;
}

export async function createAirport(ctx: RequestContext, input: CreateAirportInput): Promise<AirportDto> {
  if (await findAirportByIata(input.iata)) throw new AppError('CONFLICT', `Airport ${input.iata} already exists`);
  const created = (
    await AirportModel.create({
      iata: input.iata,
      icao: input.icao ?? null,
      name: input.name,
      city: input.city,
      state: input.state,
      region: resolveRegion(input.state, input.region),
      country: 'IN',
      lat: input.lat,
      lng: input.lng,
      active: input.active,
    })
  ).toObject();
  const dto = toAirportDto(created);
  await audit(ctx, { action: 'airport.created', entity: 'airport', entityId: dto.id, after: dto });
  return dto;
}

export async function updateAirport(ctx: RequestContext, id: string, patch: PatchAirportInput): Promise<AirportDto> {
  const before = await findAirportById(id);
  if (!before) throw new AppError('NOT_FOUND', 'Airport not found');
  const $set: Partial<AirportDoc> = {};
  if (patch.icao !== undefined) $set.icao = patch.icao;
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.city !== undefined) $set.city = patch.city;
  if (patch.state !== undefined) $set.state = patch.state;
  if (patch.region !== undefined) $set.region = patch.region;
  if (patch.lat !== undefined) $set.lat = patch.lat;
  if (patch.lng !== undefined) $set.lng = patch.lng;
  if (patch.active !== undefined) $set.active = patch.active;
  if (patch.state !== undefined && patch.region === undefined) {
    const region = regionForState(patch.state);
    if (region !== null) $set.region = region;
  }
  const after = await AirportModel.findByIdAndUpdate(before._id, { $set }, { new: true }).lean<AirportDoc>();
  if (!after) throw new AppError('NOT_FOUND', 'Airport not found');
  const dto = toAirportDto(after);
  await audit(ctx, { action: 'airport.updated', entity: 'airport', entityId: dto.id, before: toAirportDto(before), after: dto });
  return dto;
}

export interface UpsertOptions {
  /** Only fill fields on insert (seed) rather than overwrite edits (import). */
  insertOnly: boolean;
  /** IATA codes to mark active on insert. */
  activeOnInsert?: ReadonlySet<string>;
}

async function upsertRows(rows: AirportRow[], options: UpsertOptions): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const result = await AirportModel.bulkWrite(
    rows.map((row) => {
      const fields = {
        icao: row.icao ?? null,
        name: row.name,
        city: row.city,
        state: row.state,
        region: row.region,
        country: 'IN',
        lat: row.lat,
        lng: row.lng,
      };
      const active = row.active ?? options.activeOnInsert?.has(row.iata) ?? false;
      const update = options.insertOnly
        ? { $setOnInsert: { iata: row.iata, ...fields, active } }
        : {
            $set: { ...fields, ...(row.active === undefined ? {} : { active: row.active }) },
            $setOnInsert: { iata: row.iata, ...(row.active === undefined ? { active } : {}) },
          };
      return { updateOne: { filter: { iata: row.iata }, update, upsert: true } };
    }),
    { ordered: false },
  );
  return { inserted: result.upsertedCount, updated: result.modifiedCount };
}

/** POST /airports/import: upserts by IATA; existing airports are updated, rows with problems are reported and skipped. */
export async function importAirportsCsv(ctx: RequestContext, csv: string): Promise<ImportResultDto> {
  const parsed = parseAirportsCsv(csv);
  const { inserted, updated } = await upsertRows(parsed.rows, { insertOnly: false });
  const result: ImportResultDto = {
    rows: parsed.total,
    inserted,
    updated,
    rejected: parsed.total - parsed.rows.length,
    errors: parsed.errors,
  };
  await audit(ctx, { action: 'airport.imported', entity: 'airport', entityId: 'import', after: { ...result, errors: result.errors.length } });
  return result;
}

const VENDORED_CSV = new URL('./data/airports.in.csv', import.meta.url);

/** Seeds the vendored Indian airport list; never overwrites edited rows. Phase-I airports start active. */
export async function seedAirports(): Promise<{ rows: number; inserted: number; errors: number }> {
  const parsed = parseAirportsCsv(await readFile(VENDORED_CSV, 'utf8'));
  if (parsed.errors.length > 0) {
    throw new AppError('INTERNAL', 'Vendored airports CSV has invalid rows', { errors: parsed.errors });
  }
  const { inserted } = await upsertRows(parsed.rows, { insertOnly: true, activeOnInsert: new Set(PHASE_I_IATA) });
  return { rows: parsed.rows.length, inserted, errors: parsed.errors.length };
}
