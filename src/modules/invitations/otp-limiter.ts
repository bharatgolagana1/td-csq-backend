import { OTP_POLICY } from './domain/otpPolicy.js';

export interface LimiterVerdict {
  allowed: boolean;
  /** Milliseconds until the next request would be allowed (0 when allowed). */
  retryAfterMs: number;
}

/**
 * Sliding-window counter per key, kept in process memory. The per-token
 * throttle (`canResend`) lives on the invitation document; this one stops a
 * single network address from requesting codes for many tokens at once, so
 * its budget is a multiple of the per-token one and it has no cooldown.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, Date[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError(`max must be a whole number ≥ 1 (got ${max})`);
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError(`windowMs must be a whole number ≥ 1 (got ${windowMs})`);
  }

  check(key: string, now: Date): LimiterVerdict {
    const recent = this.prune(key, now);
    if (recent.length < this.max) return { allowed: true, retryAfterMs: 0 };
    const oldest = recent[0];
    const retryAfterMs = oldest === undefined ? this.windowMs : Math.max(1, oldest.getTime() + this.windowMs - now.getTime());
    return { allowed: false, retryAfterMs };
  }

  record(key: string, now: Date): void {
    const recent = this.prune(key, now);
    recent.push(now);
    this.hits.set(key, recent);
  }

  /** Tests only. */
  reset(): void {
    this.hits.clear();
  }

  private prune(key: string, now: Date): Date[] {
    const since = now.getTime() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at.getTime() > since).sort((a, b) => a.getTime() - b.getTime());
    if (recent.length === 0) this.hits.delete(key);
    else this.hits.set(key, recent);
    return recent;
  }
}

/** Ten tokens' worth of codes per address per window. */
export const OTP_IP_BUDGET = OTP_POLICY.resendMaxPerWindow * 10;

export const otpIpLimiter = new SlidingWindowLimiter(OTP_IP_BUDGET, OTP_POLICY.resendWindowMs);
