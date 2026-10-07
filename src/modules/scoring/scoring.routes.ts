import { route } from '../../core/http.js';

import { runBody, runParams, runSummaryResponse } from './scoring.schemas.js';
import { runCycleForRequest } from './scoring.service.js';

export const scoringRoutes = [
  // ARCHITECTURE §6 puts this route under `cycles.operate`. The registry only
  // lets a module name its own tasks, so the policy is `session` and the
  // service asserts the task (403 without it), as reports' export does.
  route({
    method: 'post',
    path: '/scoring/cycles/:cycleId/run',
    policy: { kind: 'session' },
    summary: 'Recompute every score of a cycle (requires cycles.operate; provisional while the assessment is open)',
    params: runParams,
    body: runBody,
    response: runSummaryResponse,
    handler: ({ ctx, params, body }) => runCycleForRequest(ctx, params.cycleId, body),
  }),
];
