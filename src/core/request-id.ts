import { randomUUID } from 'node:crypto';

import type { Request, RequestHandler } from 'express';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Accepts a well-formed `x-request-id` from the caller or mints a UUID; echoes it on the response. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.id = id;
    res.setHeader('x-request-id', id);
    next();
  };
}

/** The request id as a string (pino-http types `req.id` loosely). */
export function requestIdOf(req: Request): string {
  const id: unknown = req.id;
  return typeof id === 'string' ? id : '';
}
