import { defineModule } from '../../core/module.js';

import { assessmentsRoutes } from './assessments.routes.js';

export default defineModule({
  name: 'assessments',
  basePath: '/assessments',
  tasks: [
    { code: 'assessments.self', name: 'Self-assessment', description: 'Fill in and submit the operator’s own assessment of a cycle' },
    { code: 'assessments.view', name: 'View assessments', description: 'Browse, open and export submitted assessments in scope' },
  ],
  routes: assessmentsRoutes,
});
