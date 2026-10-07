import { defineModule } from '../../core/module.js';

import { reportsRoutes } from './reports.routes.js';

export default defineModule({
  name: 'reports',
  basePath: '/reports',
  tasks: [
    {
      code: 'reports.operator',
      name: 'Operator reports',
      description: 'Operator dashboard, question table, cycle comparison and CSV export (an ACO sees its own only)',
    },
    {
      code: 'reports.airport',
      name: 'Airport reports',
      description: 'Airport roll-up with market-share weighting and its operators table (an airport sees its own only)',
    },
    {
      code: 'reports.national',
      name: 'National reports',
      description: 'Airports and operators ranked, category averages and the participation funnel of a cycle',
    },
  ],
  routes: reportsRoutes,
});
