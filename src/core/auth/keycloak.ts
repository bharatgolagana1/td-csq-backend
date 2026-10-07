import type { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import type { Env } from '../../config/env.js';
import { AppError } from '../errors.js';

/** What a verified access token tells us. Keycloak supplies identity only. */
export interface Principal {
  sub: string;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
}

/**
 * Verifies a bearer token and returns its principal, or throws
 * UNAUTHENTICATED. Injected into `createApp` so tests can substitute a fake.
 */
export type TokenVerifier = (token: string) => Promise<Principal>;

type KeycloakEnv = Pick<Env, 'KEYCLOAK_ISSUER' | 'KEYCLOAK_JWKS_URI' | 'KEYCLOAK_AUDIENCE'>;

function claimString(payload: JWTPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Turns raw token claims into a Principal; shared by the real and fake verifiers. */
export function principalFromClaims(payload: JWTPayload): Principal {
  const sub = claimString(payload, 'sub');
  if (sub === null) throw new AppError('UNAUTHENTICATED', 'Token has no subject');
  return {
    sub,
    email: claimString(payload, 'email')?.toLowerCase() ?? null,
    name: claimString(payload, 'name') ?? claimString(payload, 'preferred_username'),
    emailVerified: payload['email_verified'] === true,
  };
}

/** RS256 verification against the realm JWKS with issuer + audience checks and 60 s clock tolerance. */
export function createTokenVerifier(env: KeycloakEnv): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(env.KEYCLOAK_JWKS_URI));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: env.KEYCLOAK_ISSUER,
        audience: env.KEYCLOAK_AUDIENCE,
        algorithms: ['RS256'],
        clockTolerance: 60,
      });
      return principalFromClaims(payload);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired token');
    }
  };
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  // Everything after the scheme is the token; a test token may legitimately contain spaces.
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  return token === undefined || token === '' ? null : token;
}

/**
 * Verifies the bearer token on the request and stores the principal on
 * `req.principal`. Throws UNAUTHENTICATED when the header is missing or the
 * token fails verification. Memoised per request.
 */
export async function authenticate(req: Request, verifyToken: TokenVerifier): Promise<Principal> {
  if (req.principal) return req.principal;
  const token = bearerToken(req);
  if (token === null) throw new AppError('UNAUTHENTICATED', 'Missing bearer token');
  const principal = await verifyToken(token);
  req.principal = principal;
  return principal;
}
