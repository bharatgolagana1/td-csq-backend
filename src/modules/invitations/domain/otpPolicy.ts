/**
 * OTP lifetime, lockout and resend throttling (ARCHITECTURE.md §7
 * "Participant link": 10 min, 5 attempts, resend after 30 s, 3 per 10 min;
 * §6 `POST /public/assess/:token/otp` and `/verify`).
 */

export const OTP_POLICY = {
  /** An OTP is valid for 10 minutes from issue. */
  ttlMs: 10 * 60_000,
  /** Wrong guesses allowed per OTP before a new one must be requested. */
  maxAttempts: 5,
  /** Minimum gap between two sends. */
  resendCooldownMs: 30_000,
  /** Sends counted within this sliding window … */
  resendWindowMs: 10 * 60_000,
  /** … may not exceed this. */
  resendMaxPerWindow: 3,
} as const;

export function otpExpiresAt(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + OTP_POLICY.ttlMs);
}

export type OtpAttemptBlock = 'NO_OTP' | 'EXPIRED' | 'LOCKED';

export interface OtpAttemptInput {
  /** Wrong guesses so far against the current OTP. */
  attempts: number;
  /** Null when no OTP has been issued. */
  expiresAt: Date | null;
  now: Date;
}

export interface OtpAttemptEvaluation {
  allowed: boolean;
  reason: OtpAttemptBlock | null;
  /** Guesses left including this one (0 when blocked). */
  attemptsLeft: number;
}

/** May the participant submit a guess now? Checks existence, expiry, then lockout. */
export function evaluateOtpAttempt({ attempts, expiresAt, now }: OtpAttemptInput): OtpAttemptEvaluation {
  if (!Number.isInteger(attempts) || attempts < 0) throw new RangeError(`attempts must be a whole number ≥ 0 (got ${attempts})`);
  if (expiresAt === null) return { allowed: false, reason: 'NO_OTP', attemptsLeft: 0 };
  if (now.getTime() >= expiresAt.getTime()) return { allowed: false, reason: 'EXPIRED', attemptsLeft: 0 };
  const attemptsLeft = Math.max(0, OTP_POLICY.maxAttempts - attempts);
  if (attemptsLeft === 0) return { allowed: false, reason: 'LOCKED', attemptsLeft: 0 };
  return { allowed: true, reason: null, attemptsLeft };
}

export interface FailedAttemptOutcome {
  attempts: number;
  attemptsLeft: number;
  /** True once the 5th wrong guess lands: the OTP is dead until a new one is requested. */
  locked: boolean;
}

/** The counter after one more wrong guess. */
export function afterFailedAttempt(attempts: number): FailedAttemptOutcome {
  const next = attempts + 1;
  const attemptsLeft = Math.max(0, OTP_POLICY.maxAttempts - next);
  return { attempts: next, attemptsLeft, locked: attemptsLeft === 0 };
}

export type ResendBlock = 'COOLDOWN' | 'RATE_LIMITED';

export interface ResendInput {
  lastSentAt: Date | null;
  /** Sends in the last `resendWindowMs` (see `countSentInWindow`). */
  sentInWindow: number;
  now: Date;
  /** Oldest send inside the window (from `summariseSends`); lets `retryAfterMs` be exact when rate-limited. */
  oldestSentInWindowAt?: Date | null;
}

export interface ResendEvaluation {
  allowed: boolean;
  reason: ResendBlock | null;
  /** Milliseconds until a resend will be allowed (0 when allowed). */
  retryAfterMs: number;
}

/** Cooldown first (30 s since the last send), then the 3-per-10-minute cap. */
export function canResend({ lastSentAt, sentInWindow, now, oldestSentInWindowAt }: ResendInput): ResendEvaluation {
  if (!Number.isInteger(sentInWindow) || sentInWindow < 0) {
    throw new RangeError(`sentInWindow must be a whole number ≥ 0 (got ${sentInWindow})`);
  }
  if (lastSentAt !== null) {
    const sinceLast = now.getTime() - lastSentAt.getTime();
    if (sinceLast < OTP_POLICY.resendCooldownMs) {
      return { allowed: false, reason: 'COOLDOWN', retryAfterMs: OTP_POLICY.resendCooldownMs - sinceLast };
    }
  }
  if (sentInWindow >= OTP_POLICY.resendMaxPerWindow) {
    const retryAfterMs =
      oldestSentInWindowAt === undefined || oldestSentInWindowAt === null
        ? OTP_POLICY.resendWindowMs
        : Math.max(1, oldestSentInWindowAt.getTime() + OTP_POLICY.resendWindowMs - now.getTime());
    return { allowed: false, reason: 'RATE_LIMITED', retryAfterMs };
  }
  return { allowed: true, reason: null, retryAfterMs: 0 };
}

export interface SendWindow {
  sentInWindow: number;
  oldestSentInWindowAt: Date | null;
  lastSentAt: Date | null;
}

/** Summarises a send history for `canResend`. */
export function summariseSends(sentAts: readonly Date[], now: Date): SendWindow {
  const since = now.getTime() - OTP_POLICY.resendWindowMs;
  const inWindow = sentAts.filter((at) => at.getTime() > since && at.getTime() <= now.getTime());
  const sorted = [...inWindow].sort((a, b) => a.getTime() - b.getTime());
  const last = sentAts.reduce<Date | null>((latest, at) => (latest === null || at > latest ? at : latest), null);
  return { sentInWindow: sorted.length, oldestSentInWindowAt: sorted[0] ?? null, lastSentAt: last };
}
