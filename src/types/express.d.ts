import type { Principal } from '../core/auth/keycloak.js';
import type { LinkSession } from '../core/auth/link.js';
import type { RequestContext } from '../core/auth/session.js';
import type { AppError } from '../core/errors.js';

declare global {
  namespace Express {
    interface Request {
      /** Request id (header `x-request-id` or a UUID); echoed in error envelopes. */
      id: string;
      /** Verified Keycloak claims, set by task/session policies. */
      principal?: Principal;
      /** Signed-in context (ARCHITECTURE §4), set by task/session policies. */
      ctx?: RequestContext;
      /** Participant / registration link session, set by link policies. */
      link?: LinkSession;
      /** Deferred bearer-token failure, raised only by routes that need a session. */
      principalError?: AppError;
    }
  }
}

export {};
