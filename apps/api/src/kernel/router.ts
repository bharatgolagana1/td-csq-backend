import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireCapability, runSystem } from './requestContext.js';
import type { Logger } from './logger.js';

/**
 * Route registration that will not let an unprotected endpoint exist.
 *
 * Every route declares a policy, the policy is validated at boot, and a module
 * whose routes do not declare one crashes the process on startup rather than
 * shipping. The prototype had a role guard that was imported and applied to
 * nothing, which is exactly the failure a boot-time check catches and a code
 * review does not.
 */

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * PUBLIC    no principal at all: health, webhooks with their own signature check
 * SELF      a principal, no organisation: profile, organisation switcher
 * ORG       a principal acting inside one organisation. Tenant filters apply
 * PLATFORM  cross-organisation staff work. Runs in system scope, reason recorded
 */
export const TENANCY_CLASSES = ['PUBLIC', 'SELF', 'ORG', 'PLATFORM'] as const;
export type TenancyClass = (typeof TENANCY_CLASSES)[number];

const CAPABILITY_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*:[a-z][a-z0-9-]*$/;

const RoutePolicySchema = z.object({
  requiredCapability: z.string().regex(CAPABILITY_RE).nullable(),
  tenancy: z.enum(TENANCY_CLASSES),
  /** Mandatory justification for an authenticated route that guards nothing. */
  openReason: z.string().min(10).optional(),
});
export type RoutePolicy = z.infer<typeof RoutePolicySchema>;

export interface RouteSpec {
  readonly method: HttpMethod;
  /** Path relative to the module base path, e.g. '/lists/:kind'. */
  readonly path: string;
  readonly summary: string;
  readonly policy: RoutePolicy;
  readonly handler: (req: Request, res: Response) => Promise<unknown> | unknown;
  /** Status for a returned body. Defaults to 200. */
  readonly status?: number;
}

export interface ApiModule {
  readonly name: string;
  /** Mounted under this, e.g. '/v1/settings'. */
  readonly basePath: string;
  /** Every capability this module invents. A route may only require one of these. */
  readonly capabilities: readonly string[];
  readonly routes: readonly RouteSpec[];
}

/** Authoring helper: gives a module definition full type checking at its source. */
export function defineModule(module: ApiModule): ApiModule {
  return module;
}

const RouteShape = z.object({
  method: z.enum(HTTP_METHODS),
  path: z.string().startsWith('/'),
  summary: z.string().min(3),
  policy: RoutePolicySchema,
  handler: z.function(),
  status: z.number().int().min(200).max(299).optional(),
});

const ModuleShape = z.object({
  name: z.string().min(2),
  basePath: z.string().startsWith('/'),
  capabilities: z.array(z.string().regex(CAPABILITY_RE)),
  routes: z.array(RouteShape).min(1),
});

export class RoutePolicyError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Route policy check failed:\n  ${problems.join('\n  ')}`);
    this.name = 'RoutePolicyError';
  }
}

/**
 * Validates a module definition arriving as unknown, because modules are found
 * and mounted by name. Type checking at the definition site is not enough when
 * the registry loads whatever a directory contains.
 */
export function checkModule(candidate: unknown): ApiModule {
  const parsed = ModuleShape.safeParse(candidate);
  if (!parsed.success) {
    const name = describeName(candidate);
    throw new RoutePolicyError(
      parsed.error.issues.map((i) => `${name}.${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  const module = candidate as ApiModule;
  const declared = new Set(module.capabilities);
  const problems: string[] = [];

  for (const route of module.routes) {
    const where = `${module.name} ${route.method.toUpperCase()} ${module.basePath}${route.path}`;
    const { requiredCapability, tenancy, openReason } = route.policy;

    if (requiredCapability !== null && !declared.has(requiredCapability)) {
      problems.push(`${where}: requires ${requiredCapability}, which the module does not declare`);
    }
    if (tenancy === 'PUBLIC' && requiredCapability !== null) {
      problems.push(`${where}: a PUBLIC route cannot require a capability`);
    }
    if (tenancy === 'PLATFORM' && requiredCapability === null) {
      problems.push(`${where}: a PLATFORM route must require a capability`);
    }
    if (tenancy !== 'PUBLIC' && requiredCapability === null && !openReason) {
      problems.push(`${where}: an authenticated route with no capability needs an openReason`);
    }
  }

  if (problems.length > 0) throw new RoutePolicyError(problems);
  return module;
}

function describeName(candidate: unknown): string {
  if (typeof candidate === 'object' && candidate !== null && 'name' in candidate) {
    const name = (candidate as { name: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '(anonymous module)';
}

export interface MountDeps {
  /** Verifies the bearer token and attaches the principal. */
  readonly authenticate: RequestHandler;
  /** Resolves which organisation the request acts in and enters that scope. */
  readonly enterOrgScope: RequestHandler;
  /** Enters a scope with a principal but no organisation. */
  readonly enterSelfScope: RequestHandler;
  readonly log: Logger;
}

function capabilityGuard(capability: string): RequestHandler {
  return (_req, _res, next) => {
    try {
      requireCapability(capability);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function platformGuard(summary: string, log: Logger): RequestHandler {
  return (_req, _res, next) => {
    // a platform route is a deliberate tenancy bypass; the route's own summary
    // is what lands in the audit log
    runSystem({ reason: `platform route: ${summary}`, log }, () => next());
  };
}

function wrap(route: RouteSpec): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => route.handler(req, res))
      .then((body) => {
        if (res.headersSent) return;
        if (body === undefined) {
          res.status(route.status ?? 204).end();
          return;
        }
        res.status(route.status ?? 200).json(body);
      })
      .catch(next);
  };
}

function guardsFor(route: RouteSpec, deps: MountDeps): RequestHandler[] {
  const guards: RequestHandler[] = [];
  switch (route.policy.tenancy) {
    case 'PUBLIC':
      break;
    case 'SELF':
      guards.push(deps.authenticate, deps.enterSelfScope);
      break;
    case 'ORG':
      guards.push(deps.authenticate, deps.enterOrgScope);
      break;
    case 'PLATFORM':
      guards.push(deps.authenticate, deps.enterSelfScope, platformGuard(route.summary, deps.log));
      break;
  }
  if (route.policy.requiredCapability !== null) {
    guards.push(capabilityGuard(route.policy.requiredCapability));
  }
  return guards;
}

/** Mounts every module, refusing to return a router if any policy is wrong. */
export function mountModules(modules: readonly unknown[], deps: MountDeps): Router {
  const checked = modules.map(checkModule);

  const seen = new Set<string>();
  for (const module of checked) {
    for (const route of module.routes) {
      const key = `${route.method} ${module.basePath}${route.path}`;
      if (seen.has(key)) throw new RoutePolicyError([`${key} is registered twice`]);
      seen.add(key);
    }
  }

  const router = Router();
  for (const module of checked) {
    const moduleRouter = Router({ mergeParams: true });
    for (const route of module.routes) {
      moduleRouter[route.method](route.path, ...guardsFor(route, deps), wrap(route));
      deps.log.debug(
        { module: module.name, route: `${route.method.toUpperCase()} ${module.basePath}${route.path}`, policy: route.policy },
        'route registered',
      );
    }
    router.use(module.basePath, moduleRouter);
  }
  return router;
}
