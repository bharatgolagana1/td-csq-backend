import { defineModule } from '../../core/module.js';

import { auditRoutes } from './audit.routes.js';

export default defineModule({
  name: 'audit',
  basePath: '/audit',
  tasks: [{ code: 'audit.view', name: 'View audit log', description: 'Read the audit trail in scope' }],
  routes: auditRoutes,
});
