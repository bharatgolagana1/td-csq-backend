// The context a job or an event handler runs under when no request exists.
//
// A SystemContext is never built from a token. It carries a written reason
// so every piece of work that happened outside a request can be traced in
// the logs and the audit trail, and services that accept `AnyContext` can
// tell the two apart with `isSystemContext()`.
import { randomUUID } from 'node:crypto';

import type { RequestContext } from './session.js';

export interface SystemContext {
  readonly system: true;
  /** Why the system is acting: 'scheduler: cycles.transitions', 'event: sample.locked'. */
  readonly reason: string;
  /** Correlates log lines and audit rows the same way a request id does. */
  readonly requestId: string;
  readonly startedAt: Date;
}

export type AnyContext = RequestContext | SystemContext;

export function systemContext(reason: string): SystemContext {
  if (reason.trim().length === 0) throw new Error('A system context needs a reason');
  return { system: true, reason, requestId: `sys-${randomUUID()}`, startedAt: new Date() };
}

export function isSystemContext(ctx: AnyContext): ctx is SystemContext {
  return (ctx as SystemContext).system;
}

/** The request context when there is one, else null — what `audit()` accepts. */
export function requestContextOf(ctx: AnyContext): RequestContext | null {
  return isSystemContext(ctx) ? null : ctx;
}
