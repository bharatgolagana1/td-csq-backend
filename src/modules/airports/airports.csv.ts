import Papa from 'papaparse';
import { z } from 'zod';

import { zodIssues } from '../../core/errors.js';

import { regionForState, REGIONS } from './airports.regions.js';

/**
 * The CSV shape accepted by `POST /airports/import` and used by the vendored
 * seed file: `iata,icao,name,city,state,region,lat,lng,active`. `icao`,
 * `region` and `active` are optional; a missing region is derived from the state.
 * Lines starting with `#` are comments.
 */
export const AIRPORT_CSV_COLUMNS = ['iata', 'icao', 'name', 'city', 'state', 'region', 'lat', 'lng', 'active'] as const;

/** Absent column, empty cell and whitespace all mean "not given". */
const optionalText = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  });

const boolText = optionalText
  .transform((value) => value?.toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']).optional())
  .transform((value) => (value === undefined ? undefined : value === 'true' || value === '1' || value === 'yes'));

export const airportRowSchema = z
  .object({
    iata: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'must be a 3-letter IATA code'),
    icao: optionalText.pipe(z.string().regex(/^[A-Z0-9]{4}$/i, 'must be a 4-character ICAO code').toUpperCase().optional()),
    name: z.string().trim().min(1, 'is required').max(200),
    city: z.string().trim().min(1, 'is required').max(120),
    state: z.string().trim().min(1, 'is required').max(120),
    region: optionalText.pipe(z.enum(REGIONS).optional()),
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    active: boolText,
  })
  .transform((row, ctx) => {
    const region = row.region ?? regionForState(row.state);
    if (region === null) {
      ctx.addIssue({ code: 'custom', path: ['region'], message: `no region known for state "${row.state}"; supply one` });
      return z.NEVER;
    }
    return { ...row, region };
  });

export type AirportRow = z.infer<typeof airportRowSchema>;

export interface CsvRowError {
  row: number;
  field: string;
  message: string;
}

export interface ParsedAirportsCsv {
  rows: AirportRow[];
  errors: CsvRowError[];
  /** Data lines seen (excluding header and comments). */
  total: number;
}

export function parseAirportsCsv(text: string): ParsedAirportsCsv {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    comments: '#',
    transformHeader: (header) => header.trim().toLowerCase(),
  });
  const rows: AirportRow[] = [];
  const errors: CsvRowError[] = [];
  const seen = new Set<string>();
  parsed.data.forEach((raw, index) => {
    const row = index + 1;
    const result = airportRowSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of zodIssues(result.error)) errors.push({ row, field: issue.path || '(row)', message: issue.message });
      return;
    }
    if (seen.has(result.data.iata)) {
      errors.push({ row, field: 'iata', message: `duplicate IATA code ${result.data.iata} in file` });
      return;
    }
    seen.add(result.data.iata);
    rows.push(result.data);
  });
  for (const error of parsed.errors) {
    if (error.row !== undefined) errors.push({ row: error.row + 1, field: '(csv)', message: error.message });
  }
  return { rows, errors, total: parsed.data.length };
}
