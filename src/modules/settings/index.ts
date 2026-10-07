import { defineModule } from '../../core/module.js';

import { settingsRoutes } from './settings.routes.js';

export default defineModule({
  name: 'settings',
  basePath: '/settings',
  tasks: [
    { code: 'settings.view', name: 'View settings', description: 'Read platform settings' },
    { code: 'settings.manage', name: 'Manage settings', description: 'Change scoring, cycle defaults and branding' },
  ],
  routes: settingsRoutes,
});
