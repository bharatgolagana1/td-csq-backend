import { defineModule } from '../../core/module.js';

import { samplingRoutes } from './sampling.routes.js';

export default defineModule({
  name: 'sampling',
  basePath: '/',
  tasks: [
    { code: 'sampling.view', name: 'View sampling', description: 'See the selection, counter and audit trail for a cycle' },
    { code: 'sampling.manage', name: 'Manage sampling', description: 'Add and remove sampled customers while sampling is open' },
    { code: 'sampling.lock', name: 'Lock sample', description: 'Lock the sample once the minimum is reached' },
    { code: 'sampling.unlock', name: 'Unlock sample', description: 'Platform: unlock a locked sample with a reason' },
  ],
  routes: samplingRoutes,
});
