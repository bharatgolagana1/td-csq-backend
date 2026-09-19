import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  AirportInput,
  BankQuestion,
  CategoryInput,
  WeightTable,
} from '../refdata.contracts.js';
import { parseCsv } from './csv.js';

/**
 * Turns the vendored reference files into values the ordinary service
 * functions accept. There is no second write path: the seed validates and
 * writes through exactly the code an administrator's bulk upload goes through,
 * so a rule that holds for the API holds for the seed.
 */

const DATA_DIRECTORIES = [
  join(__dirname, '..', 'data'),
  // compiled: dist/modules/refdata/seed -> the repository's src tree
  join(__dirname, '..', '..', '..', '..', 'src', 'modules', 'refdata', 'data'),
];

export function dataDirectory(): string {
  const found = DATA_DIRECTORIES.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`No reference data directory. Looked in:\n  ${DATA_DIRECTORIES.join('\n  ')}`);
  }
  return found;
}

function readFile(name: string): string {
  return readFileSync(join(dataDirectory(), name), 'utf8');
}

export class SeedDataError extends Error {
  constructor(file: string, problems: readonly string[]) {
    super(`${file} is not usable:\n  ${problems.join('\n  ')}`);
    this.name = 'SeedDataError';
  }
}

function parseOrThrow<T extends z.ZodTypeAny>(file: string, schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new SeedDataError(
      file,
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

export function loadCategories(): CategoryInput[] {
  const file = 'categories.yaml';
  return parseOrThrow(file, z.array(CategoryInput).min(1), parseYaml(readFile(file)));
}

const BankFile = z.object({
  bank: z.object({
    code: z.string(),
    title: z.string(),
    description: z.string().nullable().default(null),
    sourceDocuments: z.array(z.string()).default([]),
  }),
  notes: z.string().nullable().default(null),
  questions: z.array(BankQuestion).min(1),
});

export function loadQuestionBank(): z.infer<typeof BankFile> {
  const file = 'acfi-csq-phase1.yaml';
  return parseOrThrow(file, BankFile, parseYaml(readFile(file)));
}

const WeightingFile = z.object({
  profile: z.object({
    code: z.string(),
    title: z.string(),
    basis: z.enum(['EQUAL', 'CONFIGURED']),
    notes: z.string().nullable().default(null),
  }),
  weights: WeightTable,
});

export function loadWeightingProfile(): z.infer<typeof WeightingFile> {
  const file = 'weighting-acfi-phase1-equal.yaml';
  return parseOrThrow(file, WeightingFile, parseYaml(readFile(file)));
}

const CountryZones = z.record(z.string().regex(/^[A-Z]{2}$/), z.string().min(3));

/**
 * OurAirports carries no time zone, so the seed supplies one from the country.
 * A country that observes several zones is absent from the table and its rows
 * are refused rather than assigned the country's largest zone: an airport in
 * the wrong zone opens its cycle at the wrong hour, and nobody notices until
 * the invitations have gone out.
 */
export function loadCountryTimezones(): Record<string, string> {
  const file = 'country-timezones.yaml';
  return parseOrThrow(file, CountryZones, parseYaml(readFile(file)));
}

export const AIRPORT_DATASET = 'ourairports/airports.csv';

export interface AirportLoad {
  rows: AirportInput[];
  rejected: Array<{ ident: string; reason: string }>;
}

/**
 * Reads the vendored OurAirports extract. A row that cannot be turned into a
 * valid airport is reported by its upstream identifier and left out; it is not
 * patched up, because a repaired row is a row nobody checked.
 */
export function loadAirports(): AirportLoad {
  const file = 'airports.in.csv';
  const zones = loadCountryTimezones();
  const rows: AirportInput[] = [];
  const rejected: Array<{ ident: string; reason: string }> = [];

  for (const raw of parseCsv(readFile(file))) {
    const ident = raw['ident'] ?? '(no ident)';
    const country = raw['iso_country'] ?? '';
    const timezone = zones[country];
    if (timezone === undefined) {
      rejected.push({ ident, reason: `no time zone is recorded for country ${country || '(blank)'}` });
      continue;
    }

    const municipality = raw['municipality'] ?? '';
    const icao = raw['icao_code'] ?? '';
    const candidate = {
      iataCode: raw['iata_code'] ?? '',
      icaoCode: icao.length > 0 ? icao : null,
      name: raw['name'] ?? '',
      city: municipality.length > 0 ? municipality : null,
      country,
      region: raw['iso_region'] ?? '',
      latitude: Number(raw['latitude_deg']),
      longitude: Number(raw['longitude_deg']),
      timezone,
      isActive: true,
    };

    const parsed = AirportInput.safeParse(candidate);
    if (!parsed.success) {
      rejected.push({
        ident,
        reason: parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
      });
      continue;
    }
    rows.push(parsed.data);
  }

  if (rows.length === 0) throw new SeedDataError(file, ['no usable rows']);
  return { rows, rejected };
}
