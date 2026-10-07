import { describe, expect, it } from 'vitest';

import {
  generateOtp,
  generateToken,
  hashOtp,
  hashToken,
  isWellFormedOtp,
  isWellFormedToken,
  maskEmail,
  maskName,
  otpMatches,
  tokenHashesEqual,
} from '../../../src/modules/invitations/domain/token.js';

describe('tokens', () => {
  it('are 32 random bytes as 43 base64url characters, and unique', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(isWellFormedToken(token)).toBe(true);
    }
    expect(isWellFormedToken('short')).toBe(false);
    expect(isWellFormedToken(`${'a'.repeat(42)}+`)).toBe(false);
  });

  it('hash to sha256 hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateToken()));
    expect(tokenHashesEqual(hashToken(token), hashToken(token))).toBe(true);
    expect(tokenHashesEqual(hashToken(token), hashToken('other'))).toBe(false);
    expect(tokenHashesEqual('abcd', 'abcdef')).toBe(false);
  });
});

describe('OTPs', () => {
  it('are six digits, keeping leading zeros', () => {
    for (let i = 0; i < 500; i += 1) {
      const otp = generateOtp();
      expect(otp).toMatch(/^\d{6}$/);
      expect(isWellFormedOtp(otp)).toBe(true);
    }
    expect(isWellFormedOtp('12345')).toBe(false);
    expect(isWellFormedOtp('12345a')).toBe(false);
  });

  it('hash per invitation scope and verify in constant time', () => {
    const hash = hashOtp('004512', 'inv-1');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOtp('004512', 'inv-2')).not.toBe(hash);
    expect(otpMatches('004512', 'inv-1', hash)).toBe(true);
    expect(otpMatches('004513', 'inv-1', hash)).toBe(false);
    expect(otpMatches('004512', 'inv-2', hash)).toBe(false);
    expect(otpMatches('004512', 'inv-1', 'not-hex')).toBe(false);
  });
});

describe('masking', () => {
  it('keeps the first and last character of the local part and the whole domain', () => {
    expect(maskEmail('bharat@tinydata.in')).toBe('b****t@tinydata.in');
    expect(maskEmail('ab@x.in')).toBe('a****b@x.in');
    expect(maskEmail('a@x.in')).toBe('a****@x.in');
    expect(maskEmail('  Asha.Rao@falcon.in ')).toBe('A****o@falcon.in');
  });

  it('masks a string without @ entirely', () => {
    expect(maskEmail('nope')).toBe('n****e');
    expect(maskEmail('')).toBe('');
  });

  it('maskName keeps one initial per word', () => {
    expect(maskName('Bharat Golagana')).toBe('B*** G***');
    expect(maskName('  Asha ')).toBe('A***');
    expect(maskName('')).toBe('');
  });
});
