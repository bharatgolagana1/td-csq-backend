import { z } from 'zod';

import { idSchema } from '../../core/ids.js';
import { listQuerySchema } from '../../core/pagination.js';
import { emailSchema } from '../identity/identity.schemas.js';

import { CREATED_VIA, ORG_STATUSES } from './organisations.model.js';

export const orgCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_-]{1,19}$/, 'must be 2-20 characters: letters, digits, _ or -');

export const addressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).nullable().default(null),
    city: z.string().trim().min(1).max(120),
    state: z.string().trim().min(1).max(120),
    pincode: z.string().trim().regex(/^[0-9]{6}$/, 'must be a 6-digit PIN code'),
  })
  .strict();

export const contactSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: emailSchema,
    phone: z.string().trim().min(3).max(32),
  })
  .strict();

export const operationsSchema = z.object({ domestic: z.boolean(), international: z.boolean() }).strict();

const airportSummary = z.object({ id: z.string(), iata: z.string(), name: z.string() }).nullable();

export const operatorResponse = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  legalName: z.string().nullable(),
  airport: airportSummary,
  operations: operationsSchema,
  address: addressSchema.nullable(),
  contact: contactSchema.nullable(),
  status: z.enum(ORG_STATUSES),
  createdVia: z.enum(CREATED_VIA),
  memberCount: z.number(),
  customerCount: z.number(),
  /** The operator's current (cycle-less) market share at its airport, when set. */
  currentShare: z.number().nullable(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OperatorDto = z.infer<typeof operatorResponse>;

export const operatorListQuery = listQuerySchema.extend({
  airportId: idSchema.optional(),
  status: z.enum(ORG_STATUSES).optional(),
});
export type OperatorListQuery = z.infer<typeof operatorListQuery>;

export const createOperatorBody = z
  .object({
    code: orgCodeSchema,
    name: z.string().trim().min(1).max(200),
    legalName: z.string().trim().max(200).optional(),
    airportId: idSchema,
    operations: operationsSchema,
    address: addressSchema,
    contact: contactSchema,
    admin: z
      .object({
        name: z.string().trim().min(1).max(120),
        email: emailSchema,
        phone: z.string().trim().min(3).max(32),
      })
      .strict(),
    marketSharePct: z.number().min(0).max(100).optional(),
  })
  .strict();
export type CreateOperatorInput = z.infer<typeof createOperatorBody>;

export const patchOperatorBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    legalName: z.string().trim().max(200).nullable(),
    airportId: idSchema,
    operations: operationsSchema,
    address: addressSchema.nullable(),
    contact: contactSchema.nullable(),
  })
  .partial()
  .strict();
export type PatchOperatorInput = z.infer<typeof patchOperatorBody>;

// --- market share ----------------------------------------------------------

export const marketShareQuery = z.object({ cycleId: idSchema.optional() });

export const marketShareResponse = z.object({
  airportId: z.string(),
  cycleId: z.string().nullable(),
  entries: z.array(z.object({ acoId: z.string(), code: z.string(), name: z.string(), sharePct: z.number() })),
  total: z.number(),
  frozen: z.boolean(),
});
export type MarketShareDto = z.infer<typeof marketShareResponse>;

export const marketShareBody = z
  .object({
    cycleId: idSchema.nullable().optional(),
    entries: z.array(z.object({ acoId: idSchema, sharePct: z.number().min(0).max(100) }).strict()).min(1),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type MarketShareInput = z.infer<typeof marketShareBody>;
