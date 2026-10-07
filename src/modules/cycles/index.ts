import { defineModule } from '../../core/module.js';

import { registerCycleHandlers } from './cycles.handlers.js';
import { cyclesRoutes } from './cycles.routes.js';

export default defineModule({
  name: 'cycles',
  basePath: '/',
  tasks: [
    { code: 'cycles.view', name: 'View cycles', description: 'List and open assessment cycles in scope' },
    { code: 'cycles.manage', name: 'Manage cycles', description: 'Create and edit assessment cycles' },
    { code: 'cycles.publish', name: 'Publish cycles', description: 'Publish a cycle to its participating operators' },
    { code: 'cycles.operate', name: 'Operate cycles', description: 'Override the cycle clock and send reminders' },
    { code: 'monitoring.view', name: 'View monitoring', description: 'Sampling and assessment monitoring per cycle' },
  ],
  routes: cyclesRoutes,
  registerHandlers: registerCycleHandlers,
});
