import { defineModule } from '../../core/module.js';

import { registerScoringHandlers } from './scoring.handlers.js';
import { scoringRoutes } from './scoring.routes.js';

/**
 * Scores, airport roll-ups and rankings (ARCHITECTURE §5 `scores` /
 * `airport_scores`, §7 "Scoring"). Declares no task of its own: the one route
 * is governed by cycles' `cycles.operate`, and the read functions are reached
 * through reports, which carries the `reports.*` tasks.
 */
export default defineModule({
  name: 'scoring',
  basePath: '/',
  tasks: [],
  routes: scoringRoutes,
  registerHandlers: registerScoringHandlers,
});
