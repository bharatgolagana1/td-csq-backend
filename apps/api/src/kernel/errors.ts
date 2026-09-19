import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { CsqError, type ErrorCode, type ErrorEnvelope } from '@csq/contracts';
import { getContext } from './requestContext.js';
import type { Logger } from './logger.js';

export { CsqError };

/**
 * Status codes live beside the code union rather than at each throw site, so the
 * same failure cannot be a 409 in one module and a 422 in the next.
 *
 * NOT_FOUND is deliberately the answer to a cross-tenant read. There is no code
 * in the union that says "that belongs to someone else", because saying so turns
 * every list endpoint into an enumeration oracle for competitor identifiers.
 */
const STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  CONSENT_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  WINDOW_CLOSED: 409,
  WINDOW_NOT_OPEN: 409,
  SAMPLING_BELOW_MINIMUM: 422,
  BATCH_ALREADY_LOCKED: 409,
  APPROVAL_REQUIRED: 403,
  ASSESSMENT_ALREADY_SUBMITTED: 409,
  QUESTION_BANK_NOT_PUBLISHED: 409,
  WEIGHTS_DO_NOT_SUM: 422,
  INSUFFICIENT_RESPONSES: 422,
  ENTITLEMENT_REQUIRED: 402,
  RATE_LIMITED: 429,
  OTP_INVALID: 400,
  OTP_ATTEMPTS_EXCEEDED: 429,
  LINK_EXPIRED: 410,
  INTERNAL: 500,
});

export function fail(
  code: ErrorCode,
  message: string,
  fields?: ReadonlyArray<{ path: string; message: string }>,
): CsqError {
  return new CsqError(code, message, STATUS[code], fields);
}

export const notFound = (what = 'Not found'): CsqError => fail('NOT_FOUND', what);
export const forbidden = (why = 'Not permitted'): CsqError => fail('FORBIDDEN', why);
export const unauthenticated = (why = 'Authentication required'): CsqError => fail('UNAUTHENTICATED', why);
export const conflict = (why: string): CsqError => fail('CONFLICT', why);

export function fromZod(error: ZodError): CsqError {
  return fail(
    'VALIDATION_FAILED',
    'Request failed validation',
    error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
  );
}

function envelope(error: CsqError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.fields ? { fields: error.fields.map((f) => ({ ...f })) } : {}),
      requestId,
    },
  };
}

/** Terminal handler for anything that fell through the route table. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound('No such endpoint'));
};

/**
 * The single place an error becomes a response. An unrecognised error is logged
 * with everything we know and answered with a bare INTERNAL: a stack trace in a
 * response body is a free map of the codebase for whoever is probing it.
 */
export function errorHandler(log: Logger): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    const requestId = getContext()?.requestId ?? 'unknown';

    const known =
      error instanceof CsqError ? error : error instanceof ZodError ? fromZod(error) : undefined;

    if (!known) {
      log.error({ err: error, requestId }, 'unhandled error');
      res.status(500).json(envelope(fail('INTERNAL', 'Something went wrong'), requestId));
      return;
    }

    if (known.status >= 500) {
      log.error({ err: known, requestId }, 'server error');
    } else {
      log.warn({ code: known.code, status: known.status, requestId }, known.message);
    }

    res.status(known.status).json(envelope(known, requestId));
  };
}
