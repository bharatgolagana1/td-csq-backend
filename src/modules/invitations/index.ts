import { defineModule } from '../../core/module.js';

import { registerInvitationHandlers } from './invitations.handlers.js';
import { invitationsRoutes } from './invitations.routes.js';

/**
 * Participant invitations: PENDING at sample lock, tokens and e-mails when the
 * assessment opens, the public OTP flow and the link session that opens the
 * assessment. Declares no tasks: its signed-in routes are guarded by
 * `cycles.view`, `notifications.send` and `sampling.manage` (ARCHITECTURE §6).
 */
export default defineModule({
  name: 'invitations',
  basePath: '/',
  tasks: [],
  routes: invitationsRoutes,
  registerHandlers: registerInvitationHandlers,
});
