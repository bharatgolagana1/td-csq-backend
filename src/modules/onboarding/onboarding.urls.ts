// Where the public web app serves the registration form and the review
// screen. `createApp` hands PUBLIC_WEB_URL only to notifications, so this
// module reads it through config/env.ts (the one reader of process.env) and
// memoises it; the value cannot change after boot. PUBLIC_WEB_URL may carry
// the app's base path (https://dev.csq.aero/app); core/web-url.ts joins it.
import { loadEnv } from '../../config/env.js';
import { webAppUrl } from '../../core/web-url.js';

let webUrl: string | null = null;

function publicWebUrl(): string {
  webUrl ??= loadEnv().PUBLIC_WEB_URL;
  return webUrl;
}

/** `${PUBLIC_WEB_URL}/register/${token}` — what an onboarding link points at. */
export function registrationFormUrl(token: string): string {
  return webAppUrl(publicWebUrl(), `/register/${token}`);
}

/** `${PUBLIC_WEB_URL}/registrations/${registrationId}` — the reviewer's screen for one registration. */
export function registrationReviewUrl(registrationId: string): string {
  return webAppUrl(publicWebUrl(), `/registrations/${registrationId}`);
}
