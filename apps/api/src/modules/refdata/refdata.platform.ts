import type { Request } from 'express';
import { forbidden } from '../../kernel/errors.js';
import { requirePrincipal, type Principal } from '../../kernel/requestContext.js';

/**
 * Platform authority for ACFI staff, asserted in the handler.
 *
 * These routes are declared SELF rather than PLATFORM, and the capability is
 * checked here rather than by the kernel guard. Both are deliberate.
 *
 * A kernel PLATFORM route runs authenticate, enter self scope, enter system
 * scope, then check the capability. Inside a system scope hasCapability answers
 * true for everything, which is right for a worker and useless as a gate, so
 * the capability a PLATFORM route declares would admit any authenticated
 * caller. The system scope also carries no principal, so a handler could not
 * record who acted. Refdata needs neither: every collection it owns is global
 * and carries no tenancy plugin, so there is no tenant filter to bypass and
 * nothing a system scope would buy. What it does need is a real check, which is
 * this one. Every write route is built through platform() and a test asserts
 * that none was missed.
 *
 * A platform capability is granted by provisioning rather than by an
 * organisation administrator, so holding it in any active membership is the
 * right question to ask.
 */

export const PLATFORM_READ = 'refdata.platform:read';
export const PLATFORM_WRITE = 'refdata.platform:write';
export type PlatformCapability = typeof PLATFORM_READ | typeof PLATFORM_WRITE;

export const PLATFORM_READ_REASON =
  'ACFI staff read. refdata.platform:read is asserted in the handler, because a PLATFORM route enters system scope before the kernel capability guard, where every capability answers true';
export const PLATFORM_WRITE_REASON =
  'ACFI staff write. refdata.platform:write is asserted in the handler, because a PLATFORM route enters system scope before the kernel capability guard, where every capability answers true';

/** The authority decision on its own, so it can be tested without a request. */
export function assertPlatformCapability(principal: Principal, capability: PlatformCapability): void {
  const held = principal.memberships.some(
    (membership) => membership.active && membership.capabilities.includes(capability),
  );
  if (!held) throw forbidden(`Requires ${capability}`);
}

export function requirePlatformCapability(capability: PlatformCapability): Principal {
  const principal = requirePrincipal();
  assertPlatformCapability(principal, capability);
  return principal;
}

const GUARDED = Symbol.for('csq.refdata.platformGuard');

export type PlatformHandler = ((req: Request) => Promise<unknown>) & {
  readonly [GUARDED]: PlatformCapability;
};

/** Wraps a handler so the capability is checked where it is actually enforceable. */
export function platform(
  capability: PlatformCapability,
  handler: (req: Request, actor: Principal) => Promise<unknown> | unknown,
): PlatformHandler {
  const guarded = async (req: Request): Promise<unknown> => {
    const actor = requirePlatformCapability(capability);
    return handler(req, actor);
  };
  return Object.assign(guarded, { [GUARDED]: capability } as const);
}

/** Used by the module's own test to prove no staff route slipped the guard. */
export function guardedCapabilityOf(handler: unknown): PlatformCapability | undefined {
  if (typeof handler !== 'function') return undefined;
  return (handler as Partial<PlatformHandler>)[GUARDED];
}
