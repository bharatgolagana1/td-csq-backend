import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { logger } from './logger.js';
import { requestIdOf } from './request-id.js';

/** Error code → HTTP status (ARCHITECTURE §3). */
export const ERROR_STATUS = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  RATE_LIMITED: 429,
  LINK_EXPIRED: 410,
  OTP_INVALID: 400,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION: 'Invalid request',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  PRECONDITION_FAILED: 'Precondition failed',
  RATE_LIMITED: 'Too many requests',
  LINK_EXPIRED: 'This link has expired',
  OTP_INVALID: 'Invalid code',
  INTERNAL: 'Internal server error',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

/** Short constructors for the common cases. */
export const errors = {
  validation: (message: string, details?: unknown): AppError => new AppError('VALIDATION', message, details),
  unauthenticated: (message?: string): AppError => new AppError('UNAUTHENTICATED', message),
  forbidden: (message?: string): AppError => new AppError('FORBIDDEN', message),
  notFound: (what = 'Resource'): AppError => new AppError('NOT_FOUND', `${what} not found`),
  conflict: (message: string, details?: unknown): AppError => new AppError('CONFLICT', message, details),
  precondition: (message: string, details?: unknown): AppError => new AppError('PRECONDITION_FAILED', message, details),
};

export interface ValidationIssue {
  path: string;
  message: string;
}

export function zodIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

interface MongoLikeError {
  code?: unknown;
  keyPattern?: unknown;
  keyValue?: unknown;
}

interface BodyParserLikeError {
  type?: unknown;
  status?: unknown;
}

/** Maps anything thrown inside a request into an AppError. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return new AppError('VALIDATION', 'Invalid request', { issues: zodIssues(error) });
  if (typeof error === 'object' && error !== null) {
    const mongo = error as MongoLikeError;
    if (mongo.code === 11000) {
      const fields = typeof mongo.keyPattern === 'object' && mongo.keyPattern !== null ? Object.keys(mongo.keyPattern) : [];
      return new AppError('CONFLICT', `Duplicate value for ${fields.join(', ') || 'a unique field'}`, {
        fields,
        values: mongo.keyValue,
      });
    }
    const body = error as BodyParserLikeError;
    if (body.type === 'entity.parse.failed') return new AppError('VALIDATION', 'Malformed JSON body');
    if (body.type === 'entity.too.large') return new AppError('VALIDATION', 'Request body too large');
    if (body.type === 'charset.unsupported' || body.type === 'encoding.unsupported') {
      return new AppError('VALIDATION', 'Unsupported request encoding');
    }
    if ((error as { name?: unknown }).name === 'MulterError') {
      return new AppError('VALIDATION', (error as Error).message);
    }
  }
  const internal = new AppError('INTERNAL');
  internal.cause = error;
  return internal;
}

/** Terminal 404 for paths no router claimed. */
export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.path}`));
  };
}

/** Renders `{ error: { code, message, details?, requestId } }`; logs INTERNAL with the stack. */
export function errorHandler(): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    const appError = toAppError(error);
    const requestId = requestIdOf(req);
    const log = (req as { log?: typeof logger }).log ?? logger;
    if (appError.code === 'INTERNAL') {
      const cause = appError.cause instanceof Error ? appError.cause : error;
      log.error({ err: cause, requestId }, 'Unhandled error');
    } else if (appError.status >= 500) {
      log.error({ err: appError, requestId }, appError.message);
    }
    if (res.headersSent) return;
    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details !== undefined ? { details: appError.details } : {}),
        requestId,
      },
    });
  };
}
