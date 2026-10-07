// What the participant flow needs from the environment: the link-session
// signer, the public web URL and the demo OTP switch. `createApp` hands
// PUBLIC_WEB_URL only to notifications and keeps the link signer for the
// `link` policy, so this module builds its own from `config/env.ts` (the one
// reader of process.env) with the same secret, and memoises it: the values
// cannot change after boot. Tests swap it with `configureInvitations()`.
import { loadEnv } from '../../config/env.js';
import { createLinkSessions, type LinkSessions } from '../../core/auth/link.js';

export interface InvitationsConfig {
  /** Signs the participant link session after a successful OTP (HS256, same secret as the `link` policy). */
  links: LinkSessions;
  /** `PUBLIC_WEB_URL`; the invitation link is `${webUrl}/assess/${token}`. */
  webUrl: string;
  /** `DEMO_REVEAL_OTP`: when true the OTP response carries `devOtp`. */
  revealOtp: boolean;
}

let config: InvitationsConfig | null = null;

/** Replaces the configuration (tests); `null` goes back to the environment. */
export function configureInvitations(next: InvitationsConfig | null): void {
  config = next;
}

export function invitationsConfig(): InvitationsConfig {
  if (!config) {
    const env = loadEnv();
    config = { links: createLinkSessions(env.LINK_SESSION_SECRET), webUrl: env.PUBLIC_WEB_URL, revealOtp: env.DEMO_REVEAL_OTP };
  }
  return config;
}
