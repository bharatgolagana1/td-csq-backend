import { z } from 'zod';

import { listQuerySchema } from '../../core/pagination.js';

import { REGIONS } from './airports.regions.js';

export const airportResponse = z.object({
  id: z.string(),
  iata: z.string(),
  icao: z.string().nullable(),
  name: z.string(),
  city: z.string(),
  state: z.string(),
  region: z.string(),
  country: z.string(),
  lat: z.number(),
  lng: z.number(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AirportDto = z.infer<typeof airportResponse>;

export const airportListQuery = listQuerySchema.extend({
  active: z.stringbool().optional(),
  region: z.enum(REGIONS).optional(),
  state: z.string().trim().min(1).max(120).optional(),
});
export type AirportListQuery = z.infer<typeof airportListQuery>;

export const createAirportBody = z
  .object({
    iata: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'must be a 3-letter IATA code'),
    icao: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/, 'must be a 4-character ICAO code').nullable().optional(),
    name: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(120),
    state: z.string().trim().min(1).max(120),
    region: z.enum(REGIONS).optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    active: z.boolean().default(false),
  })
  .strict();
export type CreateAirportInput = z.infer<typeof createAirportBody>;

export const patchAirportBody = z
  .object({
    icao: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/).nullable(),
    name: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(120),
    state: z.string().trim().min(1).max(120),
    region: z.enum(REGIONS),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    active: z.boolean(),
  })
  .partial()
  .strict();
export type PatchAirportInput = z.infer<typeof patchAirportBody>;

export const importResultResponse = z.object({
  rows: z.number(),
  inserted: z.number(),
  updated: z.number(),
  rejected: z.number(),
  errors: z.array(z.object({ row: z.number(), field: z.string(), message: z.string() })),
});
export type ImportResultDto = z.infer<typeof importResultResponse>;
