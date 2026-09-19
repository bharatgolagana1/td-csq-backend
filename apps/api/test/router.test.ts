import { describe, expect, it } from 'vitest';
import { RoutePolicyError, checkModule, mountModules, type ApiModule } from '../src/kernel/router.js';
import { settingsModule } from '../src/modules/settings/settings.module.js';
import { MODULES } from '../src/modules/index.js';
import { silentLog } from './mongo.js';

/**
 * A module definition can arrive from anywhere the registry looks, so the boot
 * check takes unknown. These fixtures are deliberately untyped: they stand in
 * for the module a future author writes without a policy.
 */
const noPolicy: unknown = {
  name: 'rogue',
  basePath: '/v1/rogue',
  capabilities: ['rogue:read'],
  routes: [{ method: 'get', path: '/', summary: 'Leaks everything', handler: () => ({}) }],
};

const undeclaredCapability: unknown = {
  name: 'typo',
  basePath: '/v1/typo',
  capabilities: ['typo:read'],
  routes: [
    {
      method: 'get',
      path: '/',
      summary: 'Requires a capability nobody grants',
      policy: { requiredCapability: 'typo:raed', tenancy: 'ORG' },
      handler: () => ({}),
    },
  ],
};

const guardedPublicRoute: unknown = {
  name: 'confused',
  basePath: '/v1/confused',
  capabilities: ['confused:read'],
  routes: [
    {
      method: 'get',
      path: '/',
      summary: 'Public but asks for a capability',
      policy: { requiredCapability: 'confused:read', tenancy: 'PUBLIC' },
      handler: () => ({}),
    },
  ],
};

const openWithoutReason: unknown = {
  name: 'unjustified',
  basePath: '/v1/unjustified',
  capabilities: [],
  routes: [
    {
      method: 'get',
      path: '/',
      summary: 'Authenticated but guards nothing',
      policy: { requiredCapability: null, tenancy: 'ORG' },
      handler: () => ({}),
    },
  ],
};

const deps = {
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  enterSelfScope: (_req: unknown, _res: unknown, next: () => void) => next(),
  enterOrgScope: (_req: unknown, _res: unknown, next: () => void) => next(),
  log: silentLog,
} as unknown as Parameters<typeof mountModules>[1];

describe('route policy check', () => {
  it('refuses a route with no policy at all', () => {
    expect(() => checkModule(noPolicy)).toThrow(RoutePolicyError);
    expect(() => checkModule(noPolicy)).toThrow(/policy/i);
  });

  it('fails the whole boot, not just the offending route', () => {
    expect(() => mountModules([settingsModule, noPolicy], deps)).toThrow(RoutePolicyError);
  });

  it('catches a capability the module never declared', () => {
    expect(() => checkModule(undeclaredCapability)).toThrow(/does not declare/);
  });

  it('refuses a public route that pretends to be guarded', () => {
    expect(() => checkModule(guardedPublicRoute)).toThrow(/PUBLIC route cannot require/);
  });

  it('demands a written reason for an authenticated route that guards nothing', () => {
    expect(() => checkModule(openWithoutReason)).toThrow(/openReason/);
  });

  it('refuses two modules claiming the same method and path', () => {
    expect(() => mountModules([settingsModule, settingsModule], deps)).toThrow(/registered twice/);
  });

  it('accepts the modules this API actually ships', () => {
    for (const module of MODULES) expect(checkModule(module)).toBe(module);
    expect(() => mountModules([...MODULES], deps)).not.toThrow();
  });

  it('gives every shipped route a capability or a stated reason', () => {
    const shipped: ApiModule[] = [...MODULES];
    for (const module of shipped) {
      for (const route of module.routes) {
        const guarded = route.policy.requiredCapability !== null;
        const justified = typeof route.policy.openReason === 'string';
        expect(guarded || justified).toBe(true);
      }
    }
  });
});
