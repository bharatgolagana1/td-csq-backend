import { defineModule } from '../../core/module.js';

import { onboardingRoutes } from './onboarding.routes.js';

export default defineModule({
  name: 'onboarding',
  basePath: '/',
  tasks: [
    { code: 'onboarding.links', name: 'Manage onboarding links', description: 'Create, list and revoke self-registration links' },
    { code: 'onboarding.review', name: 'Review registrations', description: 'Open, approve and reject registration requests' },
  ],
  routes: onboardingRoutes,
});
