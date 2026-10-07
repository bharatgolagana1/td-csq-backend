import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { ZodType } from 'zod';

import { authenticate, type TokenVerifier } from './auth/keycloak.js';
import { resolveLink, type LinkAudience, type LinkSession, type LinkSessions } from './auth/link.js';
import { assertTask } from './auth/rbac.js';
import { resolveSession, type RequestContext } from './auth/session.js';
import { AppError, zodIssues } from './errors.js';
import { Page } from './pagination.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Every route carries exactly one policy:
 * - `public`  — no credentials.
 * - `session` — any signed-in user with an active membership (`GET /me`).
 * - `task`    — signed-in and the active role has the task (the normal case).
 * - `link`    — a participant / registration link session in `x-csq-link-token`.
 */
export type Policy =
  | { kind: 'public' }
  | { kind: 'session' }
  | { kind: 'link'; audience: LinkAudience }
  | { kind: 'task'; task: string };

type EmptyObject = Record<string, never>;

type PolicyInput<Pol extends Policy> = Pol extends { kind: 'task' | 'session' }
  ? { ctx: RequestContext }
  : Pol extends { kind: 'link' }
    ? { link: LinkSession }
    : EmptyObject;

export type RouteInput<Pol extends Policy, P, Q, B> = {
  params: P;
  query: Q;
  body: B;
  req: Request;
  res: Response;
} & PolicyInput<Pol>;

export interface RouteDefinition<Pol extends Policy = Policy, P = unknown, Q = unknown, B = unknown, R = unknown> {
  method: HttpMethod;
  path: string;
  policy: Pol;
  /** One line for the route table. */
  summary?: string;
  params?: ZodType<P>;
  query?: ZodType<Q>;
  body?: ZodType<B>;
  /** Describes (and strips) `data`; a mismatch is an INTERNAL error, never a silent leak. */
  response?: ZodType;
  /** Success status; defaults to 200 (204 when the handler returns nothing). */
  status?: number;
  /** Extra middleware before validation, e.g. multer for file uploads. */
  before?: RequestHandler[];
  // Method syntax on purpose: it keeps RouteDefinition<…specific…> assignable to AnyRoute.
  handler(input: RouteInput<Pol, P, Q, B>): Promise<R> | R;
}

export type AnyRoute = RouteDefinition;

/**
 * Declares a route. Params, query and body are validated with zod before the
 * handler runs; the handler returns the `data` payload (or a `Page`) and
 * errors — thrown or rejected — reach the error handler.
 */
export function route<Pol extends Policy, P = EmptyObject, Q = EmptyObject, B = undefined, R = unknown>(
  definition: RouteDefinition<Pol, P, Q, B, R>,
): RouteDefinition<Pol, P, Q, B, R> {
  return definition;
}

/** What policies need at request time; supplied by `createApp`. */
export interface RouteDeps {
  verifyToken: TokenVerifier;
  links: LinkSessions;
}

function parseWith<T>(schema: ZodType<T> | undefined, value: unknown, location: 'params' | 'query' | 'body'): T {
  if (!schema) return (location === 'body' ? undefined : {}) as T;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError('VALIDATION', `Invalid ${location}`, { in: location, issues: zodIssues(result.error) });
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).then(() => next(), next);
  };
}

function policyMiddleware(policy: Policy, deps: RouteDeps): RequestHandler {
  switch (policy.kind) {
    case 'public':
      return (_req, _res, next) => {
        next();
      };
    case 'session':
      return asyncHandler(async (req) => {
        await resolveSession(req, await authenticate(req, deps.verifyToken));
      });
    case 'task':
      return asyncHandler(async (req) => {
        const ctx = await resolveSession(req, await authenticate(req, deps.verifyToken));
        assertTask(ctx, policy.task);
      });
    case 'link':
      return asyncHandler(async (req) => {
        await resolveLink(req, deps.links, policy.audience);
      });
  }
}

function send(res: Response, definition: AnyRoute, result: unknown): void {
  if (res.headersSent) return;
  if (result === undefined) {
    res.status(definition.status ?? 204).end();
    return;
  }
  const status = definition.status ?? 200;
  if (result instanceof Page) {
    const data = definition.response ? definition.response.parse(result.data) : result.data;
    res.status(status).json({ data, meta: result.meta });
    return;
  }
  const data = definition.response ? definition.response.parse(result) : result;
  res.status(status).json({ data });
}

function routeHandler(definition: AnyRoute): RequestHandler {
  return (req, res, next) => {
    let result: unknown;
    try {
      const input = {
        params: parseWith(definition.params, req.params, 'params'),
        query: parseWith(definition.query, req.query, 'query'),
        body: parseWith(definition.body, req.body, 'body'),
        req,
        res,
        ...(req.ctx ? { ctx: req.ctx } : {}),
        ...(req.link ? { link: req.link } : {}),
      } as RouteInput<Policy, unknown, unknown, unknown>;
      result = definition.handler(input);
    } catch (error) {
      next(error);
      return;
    }
    Promise.resolve(result).then((value) => {
      send(res, definition, value);
    }, next);
  };
}

/** Builds an Express router from route definitions; the registry calls this per module. */
export function buildRouter(routes: readonly AnyRoute[], deps: RouteDeps): Router {
  const router = Router();
  for (const definition of routes) {
    router[definition.method](
      definition.path,
      ...(definition.before ?? []),
      policyMiddleware(definition.policy, deps),
      routeHandler(definition),
    );
  }
  return router;
}

export function describePolicy(policy: Policy): string {
  switch (policy.kind) {
    case 'public':
      return 'public';
    case 'session':
      return 'session';
    case 'link':
      return `link:${policy.audience}`;
    case 'task':
      return policy.task;
  }
}
