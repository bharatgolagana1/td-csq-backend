import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import type { Request, RequestHandler } from 'express';
import { fail, forbidden, unauthenticated } from './errors.js';
import {
  runAsPrincipal,
  runWithoutOrg,
  type Membership,
  type Principal,
} from './requestContext.js';
import { getRequestId } from './requestId.js';
import { UserModel } from './identity/models.js';
import type { Logger } from './logger.js';

/**
 * Token verification, done properly.
 *
 * The prototype called jwt.decode, which parses a token without checking its
 * signature. Anyone able to base64 a JSON object was any user in any
 * organisation. Here the signature is checked against the realm's published
 * keys, the issuer is pinned, the audience is checked, and the algorithm list
 * is closed so a token claiming alg "none" or a symmetric algorithm cannot be
 * substituted for an RSA one.
 */

export interface AuthConfig {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly audience: string;
}

/** The organisation a request acts in, when the caller belongs to several. */
export const ORG_HEADER = 'x-csq-organisation';

const principals = new WeakMap<Request, Principal>();

function bearer(req: Request): string {
  const header = req.header('authorization');
  if (!header) throw unauthenticated('Authentication required');
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw unauthenticated('Expected an Authorization: Bearer header');
  }
  return token;
}

function toPrincipal(user: {
  _id: string;
  subject: string;
  email: string | null;
  displayName: string;
  memberships: ReadonlyArray<{ orgId: string; roles: string[]; capabilities: string[]; active: boolean }>;
}): Principal {
  const memberships: Membership[] = user.memberships.map((m) => ({
    orgId: m.orgId,
    roles: [...m.roles],
    capabilities: [...m.capabilities],
    active: m.active,
  }));
  return {
    userId: user._id,
    subject: user.subject,
    email: user.email,
    displayName: user.displayName,
    memberships,
  };
}

export interface Authenticator {
  readonly authenticate: RequestHandler;
  readonly enterSelfScope: RequestHandler;
  readonly enterOrgScope: RequestHandler;
}

export function createAuthenticator(config: AuthConfig, log: Logger): Authenticator {
  // createRemoteJWKSet caches the key set and refetches on an unknown kid,
  // rate limited by cooldownDuration so a bad token cannot be used to hammer
  // the identity provider
  const jwks = createRemoteJWKSet(new URL(config.jwksUri), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
    timeoutDuration: 5 * 1000,
  });

  async function verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        clockTolerance: 60,
      });
      return payload;
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        throw fail('TOKEN_EXPIRED', 'Token expired');
      }
      log.warn({ err: error }, 'token rejected');
      throw unauthenticated('Token rejected');
    }
  }

  const authenticate: RequestHandler = (req, _res, next) => {
    void (async () => {
      const payload = await verify(bearer(req));
      const subject = payload.sub;
      if (!subject) throw unauthenticated('Token carries no subject');

      // the token says who the caller is; this system says what they may do
      const user = await UserModel.findOne({ subject }).lean().exec();
      if (!user) throw unauthenticated('No account for this identity');
      if (user.status === 'SUSPENDED') throw forbidden('Account suspended');

      principals.set(req, toPrincipal(user));
    })().then(() => next(), next);
  };

  const enterSelfScope: RequestHandler = (req, _res, next) => {
    const principal = principals.get(req);
    if (!principal) return next(unauthenticated('Authentication required'));
    return runWithoutOrg({ requestId: getRequestId(req), principal }, () => next());
  };

  const enterOrgScope: RequestHandler = (req, _res, next) => {
    const principal = principals.get(req);
    if (!principal) return next(unauthenticated('Authentication required'));

    const active = principal.memberships.filter((m) => m.active);
    const requested = req.header(ORG_HEADER)?.trim();

    let orgId: string | undefined = requested;
    if (!orgId) {
      if (active.length === 0) return next(forbidden('No active organisation membership'));
      if (active.length > 1) {
        return next(
          fail('VALIDATION_FAILED', `Send ${ORG_HEADER}: you belong to more than one organisation`, [
            { path: ORG_HEADER, message: 'required when the caller has several memberships' },
          ]),
        );
      }
      orgId = active[0]?.orgId;
    }
    if (!orgId) return next(forbidden('No active organisation membership'));

    try {
      // runAsPrincipal derives the scope from the memberships alone, so an
      // organisation header naming somewhere the caller does not belong is a 404
      return runAsPrincipal({ requestId: getRequestId(req), principal, orgId }, () => next());
    } catch (error) {
      return next(error);
    }
  };

  return { authenticate, enterSelfScope, enterOrgScope };
}

/** Exposed for the profile endpoint a later module will own. */
export function principalOf(req: Request): Principal | undefined {
  return principals.get(req);
}
