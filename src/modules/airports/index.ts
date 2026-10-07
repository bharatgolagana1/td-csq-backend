import { defineModule } from '../../core/module.js';

import { airportsRoutes } from './airports.routes.js';

export default defineModule({
  name: 'airports',
  basePath: '/airports',
  tasks: [
    { code: 'airports.view', name: 'View airports', description: 'List airports and see their operators' },
    { code: 'airports.manage', name: 'Manage airports', description: 'Create, edit and import airports' },
  ],
  routes: airportsRoutes,
});
