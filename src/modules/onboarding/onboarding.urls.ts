// Where the public web app serves the registration form and the review
// screen. `createApp` hands PUBLIC_WEB_URL only to notifications, so this
// module reads it through config/env.ts (the one reader of process.env) and
// memoises it; the value cannot change after boot.
import { loadEnv } from '../../config/env.js';

let webUrl: string | null = null;

function publicWebUrl(): string {
  webUrl ??= loadEnv().PUBLIC_WEB_URL;
  return webUrl;
}

/** `${PUBLIC_WEB_URL}/register/${token}` — what an onboarding link points at. */
export function registrationFormUrl(token: string): string {
  return `${publicWebUrl()}/register/${token}`;
}

/** The reviewer's screen for one registration. */
export function registrationReviewUrl(registrationId: string): string {
  return `${publicWebUrl()}/registrations/${registrationId}`;
}
