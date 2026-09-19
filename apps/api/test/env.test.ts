import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../src/config/env.js';

const complete = {
  NODE_ENV: 'test',
  PORT: '4000',
  MONGO_URI: 'mongodb://127.0.0.1:27017/csq-test',
  KEYCLOAK_ISSUER: 'https://auth.example.invalid/realms/csq',
  KEYCLOAK_JWKS_URI: 'https://auth.example.invalid/realms/csq/protocol/openid-connect/certs',
  KEYCLOAK_AUDIENCE: 'csq-api',
  CORS_ORIGINS: 'http://localhost:5173, https://app.example.invalid',
  LOG_LEVEL: 'silent',
};

describe('environment validation', () => {
  it('accepts a complete environment and splits the origin list', () => {
    const env = parseEnv(complete);
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://app.example.invalid']);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('names every missing variable rather than failing on the first', () => {
    const { MONGO_URI: _mongo, KEYCLOAK_AUDIENCE: _aud, ...partial } = complete;
    try {
      parseEnv(partial);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const problems = (error as EnvError).problems.join('\n');
      expect(problems).toContain('MONGO_URI is required');
      expect(problems).toContain('KEYCLOAK_AUDIENCE is required');
    }
  });

  it('refuses a connection string that is not mongodb', () => {
    expect(() => parseEnv({ ...complete, MONGO_URI: 'postgres://localhost/csq' })).toThrow(EnvError);
  });

  it('refuses a relative CORS origin', () => {
    expect(() => parseEnv({ ...complete, CORS_ORIGINS: '/app' })).toThrow(EnvError);
  });

  it('refuses a port that is not a port', () => {
    expect(() => parseEnv({ ...complete, PORT: 'four thousand' })).toThrow(EnvError);
  });
});
