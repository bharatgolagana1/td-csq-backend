// Fixed-window request limit per client IP, kept in process memory. It
// protects the public registration form (one API instance; a shared store
// would be needed only if the API were scaled out). Mounted through a route's
// `before` so every attempt counts, valid or not.
import type { RequestHandler } from 'express';

import { AppError } from '../../core/errors.js';

export interface IpRateLimitOptions {
  /** Requests allowed per IP per window. */
  max: number;
  windowMs: number;
}

export interface IpRateLimit {
  middleware: RequestHandler;
  /** Forgets every bucket; tests call it between cases. */
  reset(): void;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const SWEEP_EVERY = 1_000;

export function createIpRateLimit(options: IpRateLimitOptions): IpRateLimit {
  const buckets = new Map<string, Bucket>();
  let calls = 0;

  function sweep(now: number): void {
    for (const [ip, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(ip);
    }
  }

  return {
    middleware: (req, res, next) => {
      const now = Date.now();
      calls += 1;
      if (calls % SWEEP_EVERY === 0) sweep(now);
      const ip = req.ip ?? 'unknown';
      let bucket = buckets.get(ip);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + options.windowMs };
        buckets.set(ip, bucket);
      }
      bucket.count += 1;
      if (bucket.count > options.max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        next(new AppError('RATE_LIMITED', 'Too many registration attempts from this address; try again later', { retryAfterSeconds }));
        return;
      }
      next();
    },
    reset() {
      buckets.clear();
    },
  };
}

/** 5 form submissions per IP per 15 minutes. */
export const REGISTRATION_RATE_LIMIT: IpRateLimitOptions = { max: 5, windowMs: 15 * 60 * 1000 };

export const registrationRateLimit = createIpRateLimit(REGISTRATION_RATE_LIMIT);
