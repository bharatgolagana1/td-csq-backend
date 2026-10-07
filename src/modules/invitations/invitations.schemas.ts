import { z } from 'zod';

import { idSchema } from '../../core/ids.js';
import { listQuerySchema } from '../../core/pagination.js';
import { assessmentResponse, patchAnswersBody } from '../assessments/assessments.schemas.js';
import { SURVEY_TYPES } from '../cycles/domain/types.js';

import { INVITATION_STATES } from './domain/states.js';
import { OTP_DIGITS } from './domain/token.js';
import { CUSTOMER_TYPES } from './invitations.model.js';

const isoString = z.string();

// --- signed-in ---------------------------------------------------------------

export const invitationParams = z.object({ id: idSchema });

export const invitationListQuery = listQuerySchema.extend({
  cycleId: idSchema.optional(),
  acoId: idSchema.optional(),
  state: z.enum(INVITATION_STATES).optional(),
  surveyType: z.enum(SURVEY_TYPES).optional(),
});
export type InvitationListQuery = z.infer<typeof invitationListQuery>;

/** The operator-facing view: the participant's identity stays masked. */
export const invitationResponse = z.object({
  id: z.string(),
  cycleId: z.string(),
  acoId: z.string(),
  airportId: z.string().nullable(),
  customerId: z.string(),
  assessmentId: z.string().nullable(),
  surveyType: z.enum(SURVEY_TYPES),
  state: z.enum(INVITATION_STATES),
  emailMasked: z.string(),
  customer: z.object({ nameMasked: z.string(), type: z.enum(CUSTOMER_TYPES) }),
  sentAt: isoString.nullable(),
  openedAt: isoString.nullable(),
  verifiedAt: isoString.nullable(),
  submittedAt: isoString.nullable(),
  revokedAt: isoString.nullable(),
  expiresAt: isoString,
  remindersSent: z.number(),
  lastReminderAt: isoString.nullable(),
  createdAt: isoString,
  updatedAt: isoString,
});
export type InvitationDto = z.infer<typeof invitationResponse>;

// --- public participant flow -------------------------------------------------

/** Tokens are 43 base64url characters; anything else is simply "unknown" (404). */
export const tokenParams = z.object({ token: z.string().min(1).max(200) });

export const participantStatusResponse = z.object({
  state: z.enum(INVITATION_STATES),
  cycle: z.object({ id: z.string(), name: z.string(), assessmentEnd: isoString }),
  operator: z.object({
    name: z.string(),
    airport: z.object({ iata: z.string(), name: z.string() }).nullable(),
  }),
  surveyType: z.enum(SURVEY_TYPES),
  customer: z.object({ nameMasked: z.string(), emailMasked: z.string() }),
  submittedAt: isoString.nullable(),
  expiresAt: isoString,
});
export type ParticipantStatusDto = z.infer<typeof participantStatusResponse>;

export const otpResponse = z.object({
  sent: z.literal(true),
  expiresAt: isoString,
  /** Only when DEMO_REVEAL_OTP=true. */
  devOtp: z.string().optional(),
});
export type OtpDto = z.infer<typeof otpResponse>;

export const verifyBody = z
  .object({ otp: z.string().trim().regex(new RegExp(`^\\d{${OTP_DIGITS}}$`), `must be ${OTP_DIGITS} digits`) })
  .strict();

export const verifyResponse = z.object({
  sessionToken: z.string(),
  expiresAt: isoString,
  assessmentId: z.string(),
});
export type VerifyDto = z.infer<typeof verifyResponse>;

/** `PATCH …/answers`: the same batch assessments accepts (that module applies the form rules). */
export const answersBody = patchAnswersBody;
export type AnswersInput = z.infer<typeof answersBody>;

/** `POST …/submit`: the invitation after the submission plus the locked assessment. */
export const submitResponse = z.object({
  state: z.enum(INVITATION_STATES),
  submittedAt: isoString.nullable(),
  assessment: assessmentResponse,
});
export type SubmitDto = z.infer<typeof submitResponse>;
