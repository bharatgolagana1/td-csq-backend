import { defineModule } from '../../core/module.js';

import { organisationsRoutes } from './organisations.routes.js';

export default defineModule({
  name: 'organisations',
  basePath: '/',
  tasks: [
    { code: 'operators.view', name: 'View operators', description: 'List and open ACO operators in scope' },
    { code: 'operators.manage', name: 'Manage operators', description: 'Create, edit and deactivate operators' },
    { code: 'marketshare.view', name: 'View market share', description: 'See market shares at an airport' },
    { code: 'marketshare.manage', name: 'Manage market share', description: 'Set market shares at an airport' },
  ],
  routes: organisationsRoutes,
});
