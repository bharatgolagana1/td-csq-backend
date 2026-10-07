import type { Request, RequestHandler } from 'express';
import { errors as joseErrors, jwtVerify, SignJWT, type JWTPayload } from 'jose';

import { AppError } from '../errors.js';

/**
 * Link sessions are short-lived HS256 JWTs handed to people without a
 * Keycloak account: survey participants (after OTP) and self-registering
 * organisations. They travel in the `x-csq-link-token` header.
 */
export type LinkAudience = 'participant' | 'registration';

export const LINK_TOKEN_HEADER = 'x-csq-link-token';

export interface LinkSession {
  audience: LinkAudience;
  /** Subject chosen by the issuing module (e.g. the invitation id). */
  subject: string;
  claims: JWTPayload;
  expiresAt: Date;
}

export interface LinkSessions {
  sign(input: { audience: LinkAudience; subject: string; claims?: Record<string, unknown>; ttlSeconds: number }): Promise<string>;
  verify(token: string, audience: LinkAudience): Promise<LinkSession>;
}

export function createLinkSessions(secret: string): LinkSessions {
  const key = new TextEncoder().encode(secret);
  return {
    async sign({ audience, subject, claims = {}, ttlSeconds }) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(subject)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
        .sign(key);
    },
    async verify(token, audience) {
      try {
        const { payload } = await jwtVerify(token, key, { audience, algorithms: ['HS256'] });
        if (typeof payload.sub !== 'string' || payload.exp === undefined) {
          throw new AppError('UNAUTHENTICATED', 'Invalid link session');
        }
        return { audience, subject: payload.sub, claims: payload, expiresAt: new Date(payload.exp * 1000) };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error instanceof joseErrors.JWTExpired) throw new AppError('LINK_EXPIRED', 'Link session expired');
        throw new AppError('UNAUTHENTICATED', 'Invalid link session');
      }
    },
  };
}

export function linkToken(req: Request): string | null {
  const value = req.headers[LINK_TOKEN_HEADER];
  const token = (Array.isArray(value) ? value[0] : value)?.trim();
  return token === undefined || token === '' ? null : token;
}

/** Resolves `req.link` from the header or throws; memoised per request. */
export async function resolveLink(req: Request, sessions: LinkSessions, audience: LinkAudience): Promise<LinkSession> {
  if (req.link?.audience === audience) return req.link;
  const token = linkToken(req);
  if (token === null) throw new AppError('UNAUTHENTICATED', `Missing ${LINK_TOKEN_HEADER} header`);
  const session = await sessions.verify(token, audience);
  req.link = session;
  return session;
}

/** Express middleware form, for routers assembled outside `route()`. */
export function requireLink(sessions: LinkSessions, audience: LinkAudience): RequestHandler {
  return (req, _res, next) => {
    resolveLink(req, sessions, audience).then(() => next(), next);
  };
}
