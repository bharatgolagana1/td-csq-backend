/**
 * Invitation state machine (ARCHITECTURE.md §5 `invitations.state`, §6
 * public participant flow and `/invitations/:id/resend|revoke`, §7).
 *
 *   PENDING ──SEND──▶ SENT ──OPEN──▶ OPENED ──VERIFY──▶ VERIFIED ──SUBMIT──▶ SUBMITTED
 *
 *   RESEND  : PENDING | SENT | OPENED | VERIFIED | EXPIRED → SENT   (new token; the old link dies)
 *   OPEN    : OPENED → OPENED, VERIFIED → VERIFIED              (re-opening the page is harmless)
 *   VERIFY  : VERIFIED → VERIFIED                               (session expired, new OTP)
 *   EXPIRE  : PENDING | SENT | OPENED | VERIFIED → EXPIRED      (assessment.end passed)
 *   REVOKE  : PENDING | SENT | OPENED | VERIFIED → REVOKED      (unlock, or an operator revokes)
 *   SUBMITTED and REVOKED are terminal. EXPIRED leaves only through RESEND (after the window was extended).
 */

export type InvitationState = 'PENDING' | 'SENT' | 'OPENED' | 'VERIFIED' | 'SUBMITTED' | 'EXPIRED' | 'REVOKED';

export const INVITATION_STATES: readonly InvitationState[] = [
  'PENDING',
  'SENT',
  'OPENED',
  'VERIFIED',
  'SUBMITTED',
  'EXPIRED',
  'REVOKED',
];

export type InvitationEvent = 'SEND' | 'RESEND' | 'OPEN' | 'VERIFY' | 'SUBMIT' | 'EXPIRE' | 'REVOKE';

const LIVE: readonly InvitationState[] = ['PENDING', 'SENT', 'OPENED', 'VERIFIED'];

const TRANSITIONS: Record<InvitationEvent, Partial<Record<InvitationState, InvitationState>>> = {
  SEND: { PENDING: 'SENT' },
  RESEND: { PENDING: 'SENT', SENT: 'SENT', OPENED: 'SENT', VERIFIED: 'SENT', EXPIRED: 'SENT' },
  OPEN: { SENT: 'OPENED', OPENED: 'OPENED', VERIFIED: 'VERIFIED' },
  VERIFY: { OPENED: 'VERIFIED', VERIFIED: 'VERIFIED' },
  SUBMIT: { VERIFIED: 'SUBMITTED' },
  EXPIRE: { PENDING: 'EXPIRED', SENT: 'EXPIRED', OPENED: 'EXPIRED', VERIFIED: 'EXPIRED' },
  REVOKE: { PENDING: 'REVOKED', SENT: 'REVOKED', OPENED: 'REVOKED', VERIFIED: 'REVOKED' },
};

export type TransitionResult =
  | { ok: true; state: InvitationState; changed: boolean }
  | { ok: false; state: InvitationState; reason: string };

/** Applies `event` to `state`; refuses (without throwing) when the machine has no such edge. */
export function transition(state: InvitationState, event: InvitationEvent): TransitionResult {
  const next = TRANSITIONS[event][state];
  if (next === undefined) return { ok: false, state, reason: `${event} is not allowed for a ${state} invitation` };
  return { ok: true, state: next, changed: next !== state };
}

export function canTransition(state: InvitationState, event: InvitationEvent): boolean {
  return TRANSITIONS[event][state] !== undefined;
}

/** States from which the participant can still act (not submitted, expired or revoked). */
export function isLive(state: InvitationState): boolean {
  return LIVE.includes(state);
}

export function isTerminal(state: InvitationState): boolean {
  return state === 'SUBMITTED' || state === 'REVOKED';
}

/** Reminders go to invitations that were sent and not yet submitted (§7). */
export function canReceiveReminder(state: InvitationState): boolean {
  return state === 'SENT' || state === 'OPENED' || state === 'VERIFIED';
}

export interface InvitationExpiry {
  state: InvitationState;
  /** `assessment.end` of the cycle at send time. */
  expiresAt: Date | null;
}

/** True when the link is dead by the clock (or already marked EXPIRED); terminal states never expire. */
export function isExpired(invitation: InvitationExpiry, now: Date): boolean {
  if (invitation.state === 'EXPIRED') return true;
  if (!isLive(invitation.state)) return false;
  return invitation.expiresAt !== null && now.getTime() >= invitation.expiresAt.getTime();
}

/** The state the public page should show: EXPIRED once the clock has passed, else the stored state. */
export function effectiveState(invitation: InvitationExpiry, now: Date): InvitationState {
  return isExpired(invitation, now) ? 'EXPIRED' : invitation.state;
}
