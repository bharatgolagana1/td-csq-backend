import { defineModule } from '../../core/module.js';

import { healthRoutes } from './health.routes.js';

export default defineModule({
  name: 'health',
  basePath: '/health',
  tasks: [],
  routes: healthRoutes,
});
