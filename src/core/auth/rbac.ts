import type { RequestHandler } from 'express';

import { loadRoleTaskCodes } from '../../modules/identity/matrix.service.js';
import { getRbacVersion } from '../../modules/settings/settings.service.js';
import { AppError } from '../errors.js';

import type { RequestContext, Scope } from './session.js';

const EMPTY: ReadonlySet<string> = new Set();

/**
 * In-memory Role → Task cache keyed on `settings.rbacVersion`. Saving the
 * matrix bumps the version, so every instance rebuilds on its next request.
 */
const cache: { version: number; byRole: Map<string, ReadonlySet<string>> } = { version: -1, byRole: new Map() };

export async function getTasksForRole(roleId: string): Promise<ReadonlySet<string>> {
  const version = await getRbacVersion();
  if (version !== cache.version) {
    cache.byRole = await loadRoleTaskCodes();
    cache.version = version;
  }
  return cache.byRole.get(roleId) ?? EMPTY;
}

export function invalidateRbacCache(): void {
  cache.version = -1;
  cache.byRole = new Map();
}

export function hasTask(ctx: RequestContext, task: string): boolean {
  return ctx.tasks.has(task);
}

/** 403 when the active role lacks the task ("right organisation, missing task"). */
export function assertTask(ctx: RequestContext, task: string): void {
  if (!ctx.tasks.has(task)) {
    throw new AppError('FORBIDDEN', `Your role (${ctx.role.code}) lacks the "${task}" task`, { task });
  }
}

export function assertScope(ctx: RequestContext, ...kinds: Scope['kind'][]): void {
  if (!kinds.includes(ctx.scope.kind)) {
    throw new AppError('FORBIDDEN', `This action requires a ${kinds.join(' or ')} organisation`, { scope: kinds });
  }
}

function withCtx(check: (ctx: RequestContext) => void): RequestHandler {
  return (req, _res, next) => {
    if (!req.ctx) {
      next(new AppError('UNAUTHENTICATED', 'Session not resolved; mount this after a session policy'));
      return;
    }
    try {
      check(req.ctx);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Middleware forms for routers assembled outside `route()`; expect `req.ctx` to exist. */
export function requireTask(task: string): RequestHandler {
  return withCtx((ctx) => {
    assertTask(ctx, task);
  });
}

export function requireScope(...kinds: Scope['kind'][]): RequestHandler {
  return withCtx((ctx) => {
    assertScope(ctx, ...kinds);
  });
}
