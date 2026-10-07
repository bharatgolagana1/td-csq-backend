/**
 * Participant link tokens, OTPs and identity masking (ARCHITECTURE.md §7
 * "Participant link": 32 random bytes, base64url, stored hashed; OTP 6
 * digits; §6 masked e-mail / name on the public page and the invitations list).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const TOKEN_BYTES = 32;
export const OTP_DIGITS = 6;

/** 32 random bytes as base64url (43 characters, URL-safe, no padding). */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Cheap shape check before hitting the database with a lookup. */
export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** sha256 hex of the raw token: what `invitations.tokenHash` stores. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Six decimal digits, leading zeros kept, from a CSPRNG. */
export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

const OTP_PATTERN = /^\d{6}$/;

export function isWellFormedOtp(otp: string): boolean {
  return OTP_PATTERN.test(otp);
}

/**
 * sha256 hex of `${scope}:${otp}`. `scope` is the invitation's token hash (or
 * id) so the same six digits never hash alike across invitations.
 */
export function hashOtp(otp: string, scope: string): string {
  return createHash('sha256').update(`${scope}:${otp}`, 'utf8').digest('hex');
}

/** Constant-time comparison of a submitted OTP against the stored hash. */
export function otpMatches(otp: string, scope: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashOtp(otp, scope), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/** Constant-time comparison of two token hashes (hex). */
export function tokenHashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

const MASK = '****';

function maskWord(word: string): string {
  const chars = Array.from(word);
  const first = chars[0];
  if (first === undefined) return '';
  if (chars.length === 1) return `${first}${MASK}`;
  return `${first}${MASK}${chars[chars.length - 1] ?? ''}`;
}

/**
 * `bharat@tinydata.in` → `b****t@tinydata.in`. The domain stays readable so a
 * participant can recognise their own address; the local part keeps only its
 * first and last character. Without an `@` the whole string is masked.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return maskWord(trimmed);
  return `${maskWord(trimmed.slice(0, at))}@${trimmed.slice(at + 1)}`;
}

/** `Bharat Golagana` → `B*** G***`: one initial per word, the rest hidden. */
export function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => `${Array.from(word)[0] ?? ''}***`)
    .join(' ');
}
