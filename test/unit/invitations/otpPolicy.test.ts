import { describe, expect, it } from 'vitest';

import {
  OTP_POLICY,
  afterFailedAttempt,
  canResend,
  evaluateOtpAttempt,
  otpExpiresAt,
  summariseSends,
} from '../../../src/modules/invitations/domain/otpPolicy.js';

const t0 = new Date('2026-11-11T04:00:00Z');
const plus = (ms: number): Date => new Date(t0.getTime() + ms);
const SEC = 1000;
const MIN = 60 * SEC;

describe('policy numbers (§7)', () => {
  it('10 min, 5 attempts, 30 s cooldown, 3 per 10 min', () => {
    expect(OTP_POLICY).toEqual({ ttlMs: 10 * MIN, maxAttempts: 5, resendCooldownMs: 30 * SEC, resendWindowMs: 10 * MIN, resendMaxPerWindow: 3 });
    expect(otpExpiresAt(t0)).toEqual(plus(10 * MIN));
  });
});

describe('evaluateOtpAttempt', () => {
  const expiresAt = otpExpiresAt(t0);

  it('refuses when no OTP was issued', () => {
    expect(evaluateOtpAttempt({ attempts: 0, expiresAt: null, now: t0 })).toEqual({ allowed: false, reason: 'NO_OTP', attemptsLeft: 0 });
  });

  it('refuses from the expiry instant onwards', () => {
    expect(evaluateOtpAttempt({ attempts: 0, expiresAt, now: plus(10 * MIN - 1) }).allowed).toBe(true);
    expect(evaluateOtpAttempt({ attempts: 0, expiresAt, now: plus(10 * MIN) })).toEqual({ allowed: false, reason: 'EXPIRED', attemptsLeft: 0 });
  });

  it('allows five guesses and locks on the sixth', () => {
    for (let attempts = 0; attempts < 5; attempts += 1) {
      expect(evaluateOtpAttempt({ attempts, expiresAt, now: plus(MIN) })).toEqual({ allowed: true, reason: null, attemptsLeft: 5 - attempts });
    }
    expect(evaluateOtpAttempt({ attempts: 5, expiresAt, now: plus(MIN) })).toEqual({ allowed: false, reason: 'LOCKED', attemptsLeft: 0 });
    expect(evaluateOtpAttempt({ attempts: 9, expiresAt, now: plus(MIN) }).reason).toBe('LOCKED');
  });

  it('expiry wins over lockout', () => {
    expect(evaluateOtpAttempt({ attempts: 5, expiresAt, now: plus(11 * MIN) }).reason).toBe('EXPIRED');
  });

  it('rejects a negative counter', () => {
    expect(() => evaluateOtpAttempt({ attempts: -1, expiresAt, now: t0 })).toThrow(RangeError);
  });
});

describe('afterFailedAttempt', () => {
  it('counts down and locks exactly on the fifth wrong guess', () => {
    let attempts = 0;
    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      const outcome = afterFailedAttempt(attempts);
      outcomes.push(outcome);
      attempts = outcome.attempts;
    }
    expect(outcomes.map((o) => o.locked)).toEqual([false, false, false, false, true]);
    expect(outcomes.map((o) => o.attemptsLeft)).toEqual([4, 3, 2, 1, 0]);
    expect(afterFailedAttempt(5)).toEqual({ attempts: 6, attemptsLeft: 0, locked: true });
  });
});

describe('canResend', () => {
  it('allows a first send', () => {
    expect(canResend({ lastSentAt: null, sentInWindow: 0, now: t0 })).toEqual({ allowed: true, reason: null, retryAfterMs: 0 });
  });

  it('enforces the 30 s cooldown with an exact retry-after', () => {
    expect(canResend({ lastSentAt: t0, sentInWindow: 1, now: plus(10 * SEC) })).toEqual({ allowed: false, reason: 'COOLDOWN', retryAfterMs: 20 * SEC });
    expect(canResend({ lastSentAt: t0, sentInWindow: 1, now: plus(29_999) }).retryAfterMs).toBe(1);
    expect(canResend({ lastSentAt: t0, sentInWindow: 1, now: plus(30 * SEC) }).allowed).toBe(true);
  });

  it('caps sends at three per ten minutes', () => {
    expect(canResend({ lastSentAt: plus(-MIN), sentInWindow: 2, now: t0 }).allowed).toBe(true);
    const capped = canResend({ lastSentAt: plus(-MIN), sentInWindow: 3, now: t0, oldestSentInWindowAt: plus(-7 * MIN) });
    expect(capped).toEqual({ allowed: false, reason: 'RATE_LIMITED', retryAfterMs: 3 * MIN });
    expect(canResend({ lastSentAt: plus(-MIN), sentInWindow: 3, now: t0 })).toEqual({ allowed: false, reason: 'RATE_LIMITED', retryAfterMs: 10 * MIN });
  });

  it('reports the cooldown before the cap when both apply', () => {
    expect(canResend({ lastSentAt: plus(-5 * SEC), sentInWindow: 3, now: t0 }).reason).toBe('COOLDOWN');
  });

  it('rejects a negative count', () => {
    expect(() => canResend({ lastSentAt: null, sentInWindow: -1, now: t0 })).toThrow(RangeError);
  });
});

describe('summariseSends', () => {
  it('counts only sends inside the sliding window and finds the oldest and the latest', () => {
    const sends = [plus(-15 * MIN), plus(-9 * MIN), plus(-4 * MIN), plus(-30 * SEC)];
    expect(summariseSends(sends, t0)).toEqual({ sentInWindow: 3, oldestSentInWindowAt: plus(-9 * MIN), lastSentAt: plus(-30 * SEC) });
    expect(summariseSends([], t0)).toEqual({ sentInWindow: 0, oldestSentInWindowAt: null, lastSentAt: null });
    expect(summariseSends([plus(-10 * MIN)], t0).sentInWindow).toBe(0);
  });

  it('feeds canResend so a fourth send in ten minutes is refused', () => {
    const sends = [plus(-8 * MIN), plus(-5 * MIN), plus(-2 * MIN)];
    const summary = summariseSends(sends, t0);
    expect(canResend({ ...summary, now: t0 })).toEqual({ allowed: false, reason: 'RATE_LIMITED', retryAfterMs: 2 * MIN });
    const later = plus(2 * MIN + 1);
    expect(canResend({ ...summariseSends(sends, later), now: later }).allowed).toBe(true);
  });
});
