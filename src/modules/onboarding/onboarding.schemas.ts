import { z } from 'zod';

import { idSchema } from '../../core/ids.js';
import { listQuerySchema } from '../../core/pagination.js';
import { emailSchema } from '../identity/identity.schemas.js';
import { addressSchema, contactSchema, operationsSchema, orgCodeSchema } from '../organisations/organisations.schemas.js';

import { ONBOARDING_ORG_TYPES } from './onboarding-links.model.js';
import { REGISTRATION_STATUSES } from './registrations.model.js';

const airportSummary = z.object({ id: z.string(), iata: z.string(), name: z.string() }).nullable();

// --- links -----------------------------------------------------------------

/** Derived from `usedAt` / `expiresAt`; never stored. */
export const LINK_STATUSES = ['OPEN', 'USED', 'EXPIRED'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const onboardingLinkResponse = z.object({
  id: z.string(),
  orgType: z.enum(ONBOARDING_ORG_TYPES),
  airport: airportSummary,
  createdBy: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
  expiresAt: z.string(),
  usedAt: z.string().nullable(),
  registrationId: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(LINK_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OnboardingLinkDto = z.infer<typeof onboardingLinkResponse>;

/** The create response is the only place the raw token (inside `url`) ever appears. */
export const createdLinkResponse = onboardingLinkResponse.extend({ url: z.string() });
export type CreatedLinkDto = z.infer<typeof createdLinkResponse>;

export const linkListQuery = listQuerySchema.extend({
  orgType: z.enum(ONBOARDING_ORG_TYPES).optional(),
  airportId: idSchema.optional(),
  status: z.enum(LINK_STATUSES).optional(),
});
export type LinkListQuery = z.infer<typeof linkListQuery>;

export const createLinkBody = z
  .object({
    orgType: z.enum(ONBOARDING_ORG_TYPES),
    airportId: idSchema,
    expiresInDays: z.number().int().min(1).max(90).default(14),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type CreateLinkInput = z.infer<typeof createLinkBody>;

// --- public form -----------------------------------------------------------

export const tokenParams = z.object({ token: z.string().trim().min(1).max(128) });

export const publicLinkResponse = z.object({
  orgType: z.enum(ONBOARDING_ORG_TYPES),
  airport: airportSummary,
  expiresAt: z.string(),
  used: z.boolean(),
});
export type PublicLinkDto = z.infer<typeof publicLinkResponse>;

const adminSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: emailSchema,
    phone: z.string().trim().min(3).max(32),
  })
  .strict();

export const registrationFormBody = z
  .object({
    organisation: z
      .object({
        name: z.string().trim().min(1).max(200),
        legalName: z.string().trim().max(200).optional(),
        address: addressSchema,
        contact: contactSchema,
      })
      .strict(),
    admin: adminSchema,
    operations: operationsSchema,
    /** ACO registrations only. */
    marketSharePct: z.number().min(0).max(100).optional(),
  })
  .strict();
export type RegistrationFormInput = z.infer<typeof registrationFormBody>;

export const registrationSubmittedResponse = z.object({ registrationId: z.string() });
export type RegistrationSubmittedDto = z.infer<typeof registrationSubmittedResponse>;

// --- review ----------------------------------------------------------------

export const registrationResponse = z.object({
  id: z.string(),
  linkId: z.string().nullable(),
  orgType: z.enum(ONBOARDING_ORG_TYPES),
  airport: airportSummary,
  organisation: z.object({
    name: z.string(),
    legalName: z.string().nullable(),
    address: addressSchema,
    contact: contactSchema,
  }),
  operations: operationsSchema,
  admin: z.object({ name: z.string(), email: z.string(), phone: z.string() }),
  marketSharePct: z.number().nullable(),
  status: z.enum(REGISTRATION_STATUSES),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewNote: z.string().nullable(),
  resultOrgId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RegistrationDto = z.infer<typeof registrationResponse>;

/**
 * The airport's current market-share set, so the reviewer sees whether the
 * requested share fits: `projectedTotal` is the total after approving a
 * SUBMITTED registration as requested (and simply the total once reviewed).
 * Null for AIRPORT registrations, which carry no share.
 */
export const marketShareReview = z
  .object({
    entries: z.array(z.object({ acoId: z.string(), code: z.string(), name: z.string(), sharePct: z.number() })),
    total: z.number(),
    projectedTotal: z.number(),
  })
  .nullable();

export const registrationDetailResponse = registrationResponse.extend({ marketShare: marketShareReview });
export type RegistrationDetailDto = z.infer<typeof registrationDetailResponse>;

export const registrationListQuery = listQuerySchema.extend({
  status: z.enum(REGISTRATION_STATUSES).optional(),
  orgType: z.enum(ONBOARDING_ORG_TYPES).optional(),
  airportId: idSchema.optional(),
});
export type RegistrationListQuery = z.infer<typeof registrationListQuery>;

export const approveRegistrationBody = z
  .object({
    code: orgCodeSchema,
    /** Overrides the requested share (ACO only); omitted ⇒ the requested value, if any. */
    marketSharePct: z.number().min(0).max(100).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type ApproveRegistrationInput = z.infer<typeof approveRegistrationBody>;

export const rejectRegistrationBody = z.object({ note: z.string().trim().min(1).max(500) }).strict();
export type RejectRegistrationInput = z.infer<typeof rejectRegistrationBody>;
