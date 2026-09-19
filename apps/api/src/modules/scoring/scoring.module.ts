import type { Request } from 'express';
import { loadEnv } from '../../config/env.js';
import { createLogger, type Logger } from '../../kernel/logger.js';
import { requireOrgId, requirePrincipal, runSystem } from '../../kernel/requestContext.js';
import { defineModule, type ApiModule } from '../../kernel/router.js';
import { parseParams, parseQuery } from '../../kernel/validate.js';
import { CycleIdParam, DashboardQuery, GapQuery, RollupQuery, TrendQuery } from './scoring.contracts.js';
import type { ScoringSources } from './scoring.inputs.js';
import { createMongoSources } from './scoring.sources.js';
import type { RollupMode } from './scoring.models.js';
import {
  readCohort,
  readDashboard,
  readPerceptionGap,
  readRollups,
  readTrend,
  runScoring,
} from './scoring.service.js';

export const SCORING_READ = 'scoring:read';
export const SCORING_RUNS_WRITE = 'scoring.runs:write';
export const SCORING_FREEZE = 'scoring.cycles:freeze';
export const DASHBOARD_READ = 'dashboard:read';

export interface ScoringModuleDeps {
  /** Injected by a worker or a test. Defaults to the process logger. */
  readonly log?: Logger;
  readonly sources?: ScoringSources;
  readonly clock?: () => Date;
}

let processLogger: Logger | undefined;

/**
 * Built on first use rather than at import, so a malformed environment is still
 * the clean boot failure main.ts prints rather than a stack trace thrown while
 * the module registry is being loaded.
 */
function defaultLogger(): Logger {
  processLogger ??= createLogger(loadEnv().LOG_LEVEL, false);
  return processLogger;
}

/**
 * Both write endpoints are cross organisation work: a cohort cannot be ranked
 * from inside one tenant. They are ORG routes rather than PLATFORM ones because
 * the capability check has to happen in the caller's own organisation, and only
 * then does the handler enter system scope with a written reason. The bypass is
 * therefore logged with the cycle, the caller and the reason before any document
 * is read.
 */
async function startRun(req: Request, deps: ScoringModuleDeps, mode: RollupMode) {
  const { cycleId } = parseParams(CycleIdParam, req);
  const principal = requirePrincipal();
  const orgId = requireOrgId();
  const log = deps.log ?? defaultLogger();
  const sources = deps.sources ?? createMongoSources();
  const now = deps.clock?.() ?? new Date();

  const reason =
    mode === 'FINAL'
      ? `freeze scoring for cycle ${cycleId}, requested by ${principal.userId} of ${orgId}`
      : `provisional scoring run for cycle ${cycleId}, requested by ${principal.userId} of ${orgId}`;

  return runSystem({ reason, log }, () =>
    runScoring({
      cycleId,
      mode,
      requestedByUserId: principal.userId,
      requestedByOrgId: orgId,
      reason,
      sources,
      now,
    }),
  );
}

export function createScoringModule(deps: ScoringModuleDeps = {}): ApiModule {
  return defineModule({
    name: 'scoring',
    basePath: '/v1/scoring',
    capabilities: [SCORING_READ, SCORING_RUNS_WRITE, SCORING_FREEZE],
    routes: [
      {
        method: 'get',
        path: '/rollups',
        summary: 'Materialised rollups for this organisation',
        policy: { requiredCapability: SCORING_READ, tenancy: 'ORG' },
        handler: (req) => readRollups(parseQuery(RollupQuery, req)),
      },
      {
        method: 'get',
        path: '/trend',
        summary: 'Rating across cycles for one terminal',
        policy: { requiredCapability: SCORING_READ, tenancy: 'ORG' },
        handler: (req) => readTrend(parseQuery(TrendQuery, req)),
      },
      {
        method: 'get',
        path: '/perception-gap',
        summary: 'Self assessment against the customer sample, overall and by category',
        policy: { requiredCapability: SCORING_READ, tenancy: 'ORG' },
        handler: (req) => readPerceptionGap(parseQuery(GapQuery, req)),
      },
      {
        method: 'get',
        path: '/cohort/:cycleId',
        summary: 'The frozen league table and cohort statistics for a cycle',
        policy: { requiredCapability: SCORING_READ, tenancy: 'ORG' },
        handler: (req) => readCohort(parseParams(CycleIdParam, req).cycleId),
      },
      {
        method: 'post',
        path: '/cycles/:cycleId/runs',
        summary: 'Recompute provisional rollups for an open cycle',
        status: 201,
        policy: { requiredCapability: SCORING_RUNS_WRITE, tenancy: 'ORG' },
        handler: (req) => startRun(req, deps, 'PROVISIONAL'),
      },
      {
        method: 'post',
        path: '/cycles/:cycleId/freeze',
        summary: 'Score a closed cycle, rank the cohort and publish the league table',
        status: 201,
        policy: { requiredCapability: SCORING_FREEZE, tenancy: 'ORG' },
        handler: (req) => startRun(req, deps, 'FINAL'),
      },
    ],
  });
}

/**
 * Served from rollups only. The page behind this is already built, so the shape
 * is fixed by the frontend rather than by what happens to be convenient here.
 */
export function createDashboardModule(): ApiModule {
  return defineModule({
    name: 'dashboard',
    basePath: '/v1/dashboard',
    capabilities: [DASHBOARD_READ],
    routes: [
      {
        method: 'get',
        path: '/',
        summary: 'Everything the operator dashboard renders, for one cycle',
        policy: { requiredCapability: DASHBOARD_READ, tenancy: 'ORG' },
        handler: (req) => readDashboard(parseQuery(DashboardQuery, req)),
      },
    ],
  });
}

export const scoringModule = createScoringModule();
export const dashboardModule = createDashboardModule();

/** What the orchestrator adds to MODULES. */
export const scoringModules: readonly ApiModule[] = [scoringModule, dashboardModule];
