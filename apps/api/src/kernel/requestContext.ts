import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, forbidden, notFound } from './errors.js';
import type { Logger } from './logger.js';
import { newId } from './ids.js';

/**
 * Ambient per-request state. It exists so tenancy cannot be forgotten: the
 * Mongoose plugin reads the scope from here rather than from an argument a
 * handler has to remember to thread through, and refuses to run when there is
 * no scope at all.
 */

export interface Membership {
  readonly orgId: string;
  readonly roles: readonly string[];
  /** Capabilities granted in this organisation. The only source of authority. */
  readonly capabilities: readonly string[];
  readonly active: boolean;
}

export interface Principal {
  readonly userId: string;
  /** Keycloak "sub". Stable for the life of the account. */
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly memberships: readonly Membership[];
}

export type Scope =
  | { readonly kind: 'ORG'; readonly orgId: string; readonly capabilities: ReadonlySet<string> }
  | { readonly kind: 'SYSTEM'; readonly reason: string }
  /** Authenticated but not acting inside any organisation, or not authenticated at all. */
  | { readonly kind: 'NONE' };

export interface RequestContext {
  readonly requestId: string;
  readonly principal: Principal | null;
  readonly scope: Scope;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * There is deliberately no exported way to enter a context with a scope of your
 * choosing. Every entry point below derives the scope from data the caller does
 * not control: an organisation membership, or an explicitly recorded system
 * reason. A handler that could name its own scope would have defeated tenancy
 * with one line.
 */
function enter<T>(context: RequestContext, fn: () => T): T {
  return storage.run(Object.freeze(context), fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw fail('INTERNAL', 'No request context. Database access outside a request needs runSystem.');
  }
  return ctx;
}

export function currentScope(): Scope {
  return requireContext().scope;
}

/** The organisation every tenant-scoped query is filtered by. */
export function requireOrgId(): string {
  const scope = currentScope();
  if (scope.kind !== 'ORG') {
    throw fail('INTERNAL', `Expected an organisation scope, found ${scope.kind}`);
  }
  return scope.orgId;
}

export function requirePrincipal(): Principal {
  const { principal } = requireContext();
  if (!principal) throw fail('UNAUTHENTICATED', 'Authentication required');
  return principal;
}

export function hasCapability(capability: string): boolean {
  const scope = currentScope();
  if (scope.kind === 'SYSTEM') return true;
  return scope.kind === 'ORG' && scope.capabilities.has(capability);
}

export function requireCapability(capability: string): void {
  if (!hasCapability(capability)) {
    // right organisation, wrong capability: 403 is correct and leaks nothing,
    // because the caller already proved membership of this organisation
    throw forbidden(`Requires ${capability}`);
  }
}

/**
 * Resolves the membership the request is acting under. A request naming an
 * organisation the caller is not an active member of is answered as if that
 * organisation did not exist.
 */
function scopeFor(principal: Principal, orgId: string): Scope {
  const membership = principal.memberships.find((m) => m.orgId === orgId && m.active);
  if (!membership) throw notFound('Not found');
  return { kind: 'ORG', orgId, capabilities: new Set(membership.capabilities) };
}

export function runAsPrincipal<T>(
  args: { requestId: string; principal: Principal; orgId: string },
  fn: () => T,
): T {
  return enter(
    { requestId: args.requestId, principal: args.principal, scope: scopeFor(args.principal, args.orgId) },
    fn,
  );
}

/**
 * A principal that is not acting inside an organisation yet: the profile
 * endpoint, the organisation switcher. No tenant-scoped collection is reachable
 * from here, which is the point.
 */
export function runWithoutOrg<T>(
  args: { requestId: string; principal: Principal | null },
  fn: () => T,
): T {
  return enter({ requestId: args.requestId, principal: args.principal, scope: { kind: 'NONE' } }, fn);
}

/** For endpoints that run before anyone is known: health, webhooks. */
export function runAnonymous<T>(requestId: string, fn: () => T): T {
  return runWithoutOrg({ requestId, principal: null }, fn);
}

export interface SystemScopeOptions {
  /** Why tenancy is being bypassed. Recorded, not decorative. */
  readonly reason: string;
  /** Required, so that bypassing tenancy cannot happen without a trace. */
  readonly log: Logger;
  readonly requestId?: string;
}

/**
 * Cross-tenant access for workers: outbox drains, scheduled scoring, migrations.
 * The reason is mandatory and logged before the work starts, so an audit of
 * every tenancy bypass is a log query rather than a code review.
 */
export function runSystem<T>(options: SystemScopeOptions, fn: () => T): T {
  const reason = options.reason.trim();
  if (reason.length < 8) {
    throw fail('INTERNAL', 'runSystem needs a reason that explains the bypass');
  }
  const requestId = options.requestId ?? newId();
  options.log.info({ requestId, systemScopeReason: reason }, 'tenancy bypassed');
  return enter({ requestId, principal: null, scope: { kind: 'SYSTEM', reason } }, fn);
}
