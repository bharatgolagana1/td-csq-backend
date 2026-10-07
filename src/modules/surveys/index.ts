import { defineModule } from '../../core/module.js';

import { surveysRoutes } from './surveys.routes.js';

export default defineModule({
  name: 'surveys',
  basePath: '/surveys',
  tasks: [
    { code: 'surveys.view', name: 'View surveys', description: 'Read survey versions, their trees and form previews' },
    { code: 'surveys.manage', name: 'Manage surveys', description: 'Edit draft survey versions and publish them' },
  ],
  routes: surveysRoutes,
});
