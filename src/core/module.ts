import type { AnyRoute } from './http.js';

/** A capability code a module declares; upserted into `tasks` at boot. */
export interface TaskDefinition {
  /** `<module>.<verb>`, e.g. `cycles.manage`. */
  code: string;
  name: string;
  description: string;
}

/**
 * What every `modules/<name>/index.ts` exports. The registry (modules/index.ts)
 * mounts `routes` under `/api/v1<basePath>` and refuses to boot when a route
 * names a task the module did not declare.
 *
 * `registerHandlers` subscribes the module's event listeners (core/events.ts)
 * and hook registrations (e.g. organisations' customer counter). The registry
 * calls it exactly once per module when the API router is built, so handlers
 * exist in the server and in every test app alike.
 */
export interface ModuleDefinition {
  name: string;
  /** Mount point under /api/v1; use '/' when the module serves several top-level paths. */
  basePath: string;
  tasks: readonly TaskDefinition[];
  routes: readonly AnyRoute[];
  registerHandlers?: () => void;
}

export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  return definition;
}
