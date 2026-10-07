import { defineModule } from '../../core/module.js';

import { notificationsRoutes } from './notifications.routes.js';

export default defineModule({
  name: 'notifications',
  basePath: '/notifications',
  tasks: [
    { code: 'notifications.view', name: 'View notifications', description: 'Read the notification log in scope' },
    { code: 'notifications.send', name: 'Send notifications', description: 'Resend notifications and invitations' },
  ],
  routes: notificationsRoutes,
});
