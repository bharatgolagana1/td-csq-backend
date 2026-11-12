// Assessor identity on the signed-in side (ARCHITECTURE §6 assessments,
// §7 "Confidentiality"): platform roles always see who answered; everyone
// else only when `settings.revealAssessorIdentity` is on — otherwise a
// customer's name and e-mail are not sent at all (not even masked). A
// self-assessment names the operator's own user and is never hidden.
import type { RequestContext } from '../../core/auth/session.js';

export interface AssessorIdentity {
  name: string | null;
  email: string | null;
}

export interface AssessorView extends AssessorIdentity {
  /** True when the caller is shown the real identity. */
  revealed: boolean;
}

/** `asha.rao@delcargo.test` → `a***@delcargo.test` (the compact column next to a revealed name). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.charAt(0)}***${email.slice(at)}`;
}

export function revealsIdentity(ctx: RequestContext, settings: { revealAssessorIdentity: boolean }): boolean {
  return ctx.scope.kind === 'PLATFORM' || settings.revealAssessorIdentity;
}

export function assessorView(identity: AssessorIdentity, reveal: boolean): AssessorView {
  return reveal ? { ...identity, revealed: true } : { name: null, email: null, revealed: false };
}
