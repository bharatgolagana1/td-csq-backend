import { defineModule } from '../../core/module.js';
import { registerCustomerCounter } from '../organisations/operators.service.js';

import { customersRoutes } from './customers.routes.js';
import { countByAcos } from './customers.service.js';

export default defineModule({
  name: 'customers',
  basePath: '/customers',
  tasks: [
    { code: 'customers.view', name: 'View customers', description: "List and open the operator's FF / CB directory" },
    { code: 'customers.manage', name: 'Manage customers', description: 'Add, edit, deactivate and bulk-import customers' },
  ],
  routes: customersRoutes,
  registerHandlers: () => {
    registerCustomerCounter(countByAcos);
  },
});
