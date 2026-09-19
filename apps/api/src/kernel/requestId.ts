import type { Request, RequestHandler } from 'express';
import { newId } from './ids.js';
import { runAnonymous } from './requestContext.js';

export const REQUEST_ID_HEADER = 'x-request-id';

const ids = new WeakMap<Request, string>();

/** Safe characters only: the id is echoed in a response header and in logs. */
const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Opens the ambient context for the whole request. Everything downstream, the
 * error handler included, can name the request without threading an argument
 * through every layer.
 */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const supplied = req.header(REQUEST_ID_HEADER);
  const requestId = supplied && SAFE_ID.test(supplied) ? supplied : newId();
  ids.set(req, requestId);
  res.setHeader(REQUEST_ID_HEADER, requestId);
  runAnonymous(requestId, () => next());
};

export function getRequestId(req: Request): string {
  return ids.get(req) ?? newId();
}
