import { z } from 'zod';

/**
 * The complete set of error codes the API may return. Adding a member here is
 * the only way to introduce a new failure mode, so the frontend can exhaustively
 * switch on it.
 *
 * Note the deliberate absence of a "cross tenant" code visible to callers: a
 * request for another organisation's document returns NOT_FOUND, byte-identical
 * to a document that never existed. A 403 there would turn every list endpoint
 * into an enumeration oracle for competitor identifiers.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'CONSENT_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'WINDOW_CLOSED',
  'WINDOW_NOT_OPEN',
  'SAMPLING_BELOW_MINIMUM',
  'BATCH_ALREADY_LOCKED',
  'APPROVAL_REQUIRED',
  'ASSESSMENT_ALREADY_SUBMITTED',
  'QUESTION_BANK_NOT_PUBLISHED',
  'WEIGHTS_DO_NOT_SUM',
  'INSUFFICIENT_RESPONSES',
  'ENTITLEMENT_REQUIRED',
  'RATE_LIMITED',
  'OTP_INVALID',
  'OTP_ATTEMPTS_EXCEEDED',
  'LINK_EXPIRED',
  'INTERNAL',
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    /** Field-level detail, only ever populated for VALIDATION_FAILED. */
    fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export class CsqError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly fields?: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'CsqError';
  }
}
