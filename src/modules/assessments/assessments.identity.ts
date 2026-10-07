// Assessor identity on the signed-in side (ARCHITECTURE §6 assessments,
// §7 "Confidentiality"): platform roles always see who answered; everyone
// else only when `settings.revealAssessorIdentity` is on. A self-assessment
// names the operator's own user and is never masked.
import type { RequestContext } from '../../core/auth/session.js';

export interface AssessorIdentity {
  name: string | null;
  email: string | null;
}

export interface AssessorView extends AssessorIdentity {
  /** True when the caller is shown the real identity. */
  revealed: boolean;
}

/** `Asha Rao` → `A*** R***`; `asha.rao@delcargo.test` → `a***@delcargo.test`. */
export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0)}***`)
    .join(' ');
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.charAt(0)}***${email.slice(at)}`;
}

export function maskIdentity(identity: AssessorIdentity): AssessorIdentity {
  return {
    name: identity.name === null ? null : maskName(identity.name),
    email: identity.email === null ? null : maskEmail(identity.email),
  };
}

export function revealsIdentity(ctx: RequestContext, settings: { revealAssessorIdentity: boolean }): boolean {
  return ctx.scope.kind === 'PLATFORM' || settings.revealAssessorIdentity;
}

export function assessorView(identity: AssessorIdentity, reveal: boolean): AssessorView {
  return reveal ? { ...identity, revealed: true } : { ...maskIdentity(identity), revealed: false };
}
