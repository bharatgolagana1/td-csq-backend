import { describe, expect, it } from 'vitest';

import { parseEnv } from '../src/config/env.js';

const valid: Record<string, string> = {
  MONGO_URI: 'mongodb://127.0.0.1:27017/csq?replicaSet=rs0',
  KEYCLOAK_ISSUER: 'https://auth.example.com/realms/csq',
  KEYCLOAK_JWKS_URI: 'https://auth.example.com/realms/csq/protocol/openid-connect/certs',
  KEYCLOAK_AUDIENCE: 'csq-api',
  CORS_ORIGINS: 'http://localhost:5173',
  PUBLIC_WEB_URL: 'http://localhost:5173',
  LINK_SESSION_SECRET: 'a-secret-that-is-at-least-32-characters-long',
  MAIL_FROM: 'CSQ <no-reply@example.com>',
};

describe('config/env', () => {
  it('accepts a complete environment and applies defaults', () => {
    const result = parseEnv(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.NODE_ENV).toBe('development');
    expect(result.env.PORT).toBe(4000);
    expect(result.env.LOG_LEVEL).toBe('info');
    expect(result.env.SCHEDULER_ENABLED).toBe(true);
    expect(result.env.DEMO_REVEAL_OTP).toBe(false);
    expect(result.env.CORS_ORIGINS).toEqual(['http://localhost:5173']);
    expect(result.env.SMTP_URL).toBeUndefined();
  });

  it('lists every problem at once', () => {
    const result = parseEnv({ ...valid, MONGO_URI: undefined, LINK_SESSION_SECRET: 'short', KEYCLOAK_ISSUER: 'not a url' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(3);
    expect(result.problems).toContain('MONGO_URI: is required');
    expect(result.problems).toContain('LINK_SESSION_SECRET: must be at least 32 characters');
    expect(result.problems.some((p) => p.startsWith('KEYCLOAK_ISSUER:'))).toBe(true);
  });

  it('treats empty strings as unset', () => {
    const ok = parseEnv({ ...valid, SMTP_URL: '' });
    expect(ok.ok && ok.env.SMTP_URL === undefined).toBe(true);
    const bad = parseEnv({ ...valid, MONGO_URI: '   ' });
    expect(!bad.ok && bad.problems.includes('MONGO_URI: is required')).toBe(true);
  });

  it('requires the Keycloak admin variables together', () => {
    const result = parseEnv({ ...valid, KEYCLOAK_ADMIN_URL: 'https://auth.example.com' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]).toMatch(/must be set together/);
    const complete = parseEnv({
      ...valid,
      KEYCLOAK_ADMIN_URL: 'https://auth.example.com',
      KEYCLOAK_ADMIN_CLIENT_ID: 'csq-admin',
      KEYCLOAK_ADMIN_CLIENT_SECRET: 'x',
    });
    expect(complete.ok).toBe(true);
  });

  it('parses booleans, numbers and comma lists', () => {
    const result = parseEnv({
      ...valid,
      PORT: '5001',
      SCHEDULER_ENABLED: 'false',
      DEMO_REVEAL_OTP: 'yes',
      CORS_ORIGINS: 'http://a.test, https://b.test',
      NODE_ENV: 'production',
      SMTP_URL: 'smtp://user:pass@mail.test:587',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.PORT).toBe(5001);
    expect(result.env.SCHEDULER_ENABLED).toBe(false);
    expect(result.env.DEMO_REVEAL_OTP).toBe(true);
    expect(result.env.CORS_ORIGINS).toEqual(['http://a.test', 'https://b.test']);
    expect(result.env.NODE_ENV).toBe('production');
    expect(result.env.SMTP_URL).toBe('smtp://user:pass@mail.test:587');
  });

  it('rejects malformed values', () => {
    const result = parseEnv({ ...valid, MONGO_URI: 'postgres://x', SMTP_URL: 'http://mail', NODE_ENV: 'staging', PORT: '70000' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.split(':')[0]).sort()).toEqual(['MONGO_URI', 'NODE_ENV', 'PORT', 'SMTP_URL']);
  });
});
