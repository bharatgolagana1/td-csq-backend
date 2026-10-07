import { describe, expect, it } from 'vitest';

import {
  INVITATION_STATES,
  canReceiveReminder,
  canTransition,
  effectiveState,
  isExpired,
  isLive,
  isTerminal,
  transition,
  type InvitationEvent,
  type InvitationState,
} from '../../../src/modules/invitations/domain/states.js';

const step = (state: InvitationState, event: InvitationEvent): InvitationState => {
  const result = transition(state, event);
  if (!result.ok) throw new Error(result.reason);
  return result.state;
};

describe('transition', () => {
  it('walks the happy path PENDING → SENT → OPENED → VERIFIED → SUBMITTED', () => {
    let state: InvitationState = 'PENDING';
    state = step(state, 'SEND');
    expect(state).toBe('SENT');
    state = step(state, 'OPEN');
    expect(state).toBe('OPENED');
    state = step(state, 'VERIFY');
    expect(state).toBe('VERIFIED');
    state = step(state, 'SUBMIT');
    expect(state).toBe('SUBMITTED');
  });

  it('refuses skipping ahead', () => {
    expect(transition('PENDING', 'OPEN')).toEqual({ ok: false, state: 'PENDING', reason: 'OPEN is not allowed for a PENDING invitation' });
    expect(transition('SENT', 'VERIFY').ok).toBe(false);
    expect(transition('SENT', 'SUBMIT').ok).toBe(false);
    expect(transition('OPENED', 'SUBMIT').ok).toBe(false);
    expect(transition('SENT', 'SEND').ok).toBe(false);
  });

  it('is idempotent where the page may repeat an action', () => {
    expect(transition('OPENED', 'OPEN')).toEqual({ ok: true, state: 'OPENED', changed: false });
    expect(transition('VERIFIED', 'OPEN')).toEqual({ ok: true, state: 'VERIFIED', changed: false });
    expect(transition('VERIFIED', 'VERIFY')).toEqual({ ok: true, state: 'VERIFIED', changed: false });
  });

  it('SUBMITTED and REVOKED are terminal', () => {
    for (const event of ['SEND', 'RESEND', 'OPEN', 'VERIFY', 'SUBMIT', 'EXPIRE', 'REVOKE'] as const) {
      expect(transition('SUBMITTED', event).ok).toBe(false);
      expect(transition('REVOKED', event).ok).toBe(false);
    }
    expect(INVITATION_STATES.filter(isTerminal)).toEqual(['SUBMITTED', 'REVOKED']);
  });

  it('EXPIRE and REVOKE apply to every live state', () => {
    for (const state of ['PENDING', 'SENT', 'OPENED', 'VERIFIED'] as const) {
      expect(step(state, 'EXPIRE')).toBe('EXPIRED');
      expect(step(state, 'REVOKE')).toBe('REVOKED');
      expect(isLive(state)).toBe(true);
    }
    expect(transition('EXPIRED', 'REVOKE').ok).toBe(false);
    expect(transition('EXPIRED', 'EXPIRE').ok).toBe(false);
  });

  it('RESEND puts a live or expired invitation back to SENT', () => {
    for (const state of ['PENDING', 'SENT', 'OPENED', 'VERIFIED', 'EXPIRED'] as const) {
      expect(step(state, 'RESEND')).toBe('SENT');
      expect(canTransition(state, 'RESEND')).toBe(true);
    }
    expect(canTransition('REVOKED', 'RESEND')).toBe(false);
    expect(canTransition('SUBMITTED', 'RESEND')).toBe(false);
  });

  it('reminders go only to sent, unsubmitted invitations', () => {
    expect(INVITATION_STATES.filter(canReceiveReminder)).toEqual(['SENT', 'OPENED', 'VERIFIED']);
  });
});

describe('isExpired / effectiveState', () => {
  const expiresAt = new Date('2026-12-10T18:30:00Z');

  it('expires live invitations from the instant, and never terminal ones', () => {
    const before = new Date('2026-12-10T18:29:59Z');
    expect(isExpired({ state: 'SENT', expiresAt }, before)).toBe(false);
    expect(isExpired({ state: 'SENT', expiresAt }, expiresAt)).toBe(true);
    expect(isExpired({ state: 'VERIFIED', expiresAt }, new Date('2027-01-01T00:00:00Z'))).toBe(true);
    expect(isExpired({ state: 'SUBMITTED', expiresAt }, new Date('2027-01-01T00:00:00Z'))).toBe(false);
    expect(isExpired({ state: 'REVOKED', expiresAt }, new Date('2027-01-01T00:00:00Z'))).toBe(false);
    expect(isExpired({ state: 'EXPIRED', expiresAt: null }, before)).toBe(true);
    expect(isExpired({ state: 'SENT', expiresAt: null }, new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });

  it('effectiveState shows EXPIRED by the clock without a stored change', () => {
    expect(effectiveState({ state: 'OPENED', expiresAt }, new Date('2026-12-01T00:00:00Z'))).toBe('OPENED');
    expect(effectiveState({ state: 'OPENED', expiresAt }, expiresAt)).toBe('EXPIRED');
    expect(effectiveState({ state: 'SUBMITTED', expiresAt }, new Date('2027-01-01T00:00:00Z'))).toBe('SUBMITTED');
  });
});
