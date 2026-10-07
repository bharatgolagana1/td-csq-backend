import { defineModule } from '../../core/module.js';

import { identityRoutes } from './identity.routes.js';

export default defineModule({
  name: 'identity',
  basePath: '/',
  tasks: [
    { code: 'users.view', name: 'View users', description: 'List users and their memberships in scope' },
    { code: 'users.manage', name: 'Manage users', description: 'Invite users, edit them and change memberships' },
    { code: 'roles.view', name: 'View roles', description: 'See roles and the Role → Task matrix' },
    { code: 'roles.manage', name: 'Manage roles', description: 'Create roles and save the Role → Task matrix' },
  ],
  routes: identityRoutes,
});
