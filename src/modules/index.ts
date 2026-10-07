// The module registry. Add a module by importing its index and appending it
// to `modules` (dependency order). Boot refuses to start when a route lacks a
// policy, names a task its module did not declare, or when two modules
// declare the same task or route.
import { Router } from 'express';

import { buildRouter, describePolicy, type RouteDeps } from '../core/http.js';
import type { ModuleDefinition, TaskDefinition } from '../core/module.js';

import airports from './airports/index.js';
import audit from './audit/index.js';
import health from './health/index.js';
import identity from './identity/index.js';
import { upsertTasks } from './identity/matrix.service.js';
import notifications from './notifications/index.js';
import organisations from './organisations/index.js';
import settings from './settings/index.js';

export const modules: readonly ModuleDefinition[] = [identity, airports, organisations, settings, audit, notifications, health];

const TASK_CODE = /^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/;
const POLICY_KINDS = new Set(['public', 'session', 'link', 'task']);

function joinPath(basePath: string, path: string): string {
  const joined = `${basePath.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  return joined.replace(/\/+$/, '') || '/';
}

export interface RouteTableEntry {
  module: string;
  method: string;
  path: string;
  policy: string;
  summary: string;
}

export function routeTable(definitions: readonly ModuleDefinition[] = modules): RouteTableEntry[] {
  return definitions.flatMap((module) =>
    module.routes.map((route) => ({
      module: module.name,
      method: route.method.toUpperCase(),
      path: `/api/v1${joinPath(module.basePath, route.path)}`,
      policy: describePolicy(route.policy),
      summary: route.summary ?? '',
    })),
  );
}

/** Throws one Error listing every problem, so a broken module cannot boot. */
export function validateModules(definitions: readonly ModuleDefinition[] = modules): void {
  const problems: string[] = [];
  const taskOwner = new Map<string, string>();
  const names = new Set<string>();
  const routeKeys = new Set<string>();

  for (const module of definitions) {
    if (names.has(module.name)) problems.push(`module "${module.name}" is registered twice`);
    names.add(module.name);
    const declared = new Set<string>();
    for (const task of module.tasks) {
      if (!TASK_CODE.test(task.code)) problems.push(`${module.name}: task "${task.code}" must look like "module.verb"`);
      const owner = taskOwner.get(task.code);
      if (owner) problems.push(`${module.name}: task "${task.code}" is already declared by module "${owner}"`);
      taskOwner.set(task.code, module.name);
      declared.add(task.code);
    }
    for (const route of module.routes) {
      const where = `${module.name} ${route.method.toUpperCase()} ${joinPath(module.basePath, route.path)}`;
      const policy: unknown = route.policy;
      if (typeof policy !== 'object' || policy === null || !POLICY_KINDS.has((policy as { kind?: string }).kind ?? '')) {
        problems.push(`${where}: route has no policy`);
        continue;
      }
      if (route.policy.kind === 'task' && !declared.has(route.policy.task)) {
        problems.push(`${where}: references task "${route.policy.task}" which module "${module.name}" does not declare`);
      }
      const key = `${route.method} ${joinPath(module.basePath, route.path)}`;
      if (routeKeys.has(key)) problems.push(`${where}: duplicate route`);
      routeKeys.add(key);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Module registry is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Every declared task with its owning module, for the boot upsert and the seed. */
export function collectTasks(definitions: readonly ModuleDefinition[] = modules): (TaskDefinition & { module: string })[] {
  return definitions.flatMap((module) => module.tasks.map((task) => ({ ...task, module: module.name })));
}

/** Upserts every declared task into `tasks`; never deletes. Called at boot and by the seed. */
export async function syncModuleTasks(definitions: readonly ModuleDefinition[] = modules): Promise<void> {
  await upsertTasks(collectTasks(definitions));
}

const handlersRegisteredFor = new Set<string>();

/**
 * Subscribes each module's event listeners and hooks exactly once per process,
 * however many apps a test file builds (core/events.ts refuses duplicates).
 */
export function registerModuleHandlers(definitions: readonly ModuleDefinition[] = modules): void {
  for (const module of definitions) {
    if (!module.registerHandlers || handlersRegisteredFor.has(module.name)) continue;
    module.registerHandlers();
    handlersRegisteredFor.add(module.name);
  }
}

/** Validates the registry and mounts every module; the result is mounted at /api/v1 by `createApp`. */
export function buildApiRouter(deps: RouteDeps, definitions: readonly ModuleDefinition[] = modules): Router {
  validateModules(definitions);
  registerModuleHandlers(definitions);
  const api = Router();
  for (const module of definitions) {
    api.use(module.basePath, buildRouter(module.routes, deps));
  }
  return api;
}
