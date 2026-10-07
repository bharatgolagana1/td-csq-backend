// Builds a signed-in test client without Keycloak: tokens are `test:<json>`
// and the fake verifier turns the JSON into the principal.
import type { Express } from 'express';
import type { JWTPayload } from 'jose';
import mongoose from 'mongoose';
import request, { type Test } from 'supertest';

import { createApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { principalFromClaims, type TokenVerifier } from '../../src/core/auth/keycloak.js';
import { invalidateRbacCache } from '../../src/core/auth/rbac.js';
import { connectDb, disconnectDb, ensureIndexes, isDbConnected } from '../../src/core/db.js';
import { AppError } from '../../src/core/errors.js';
import { idString } from '../../src/core/ids.js';
import { initLogger } from '../../src/core/logger.js';
import { scheduler } from '../../src/core/scheduler.js';
import { ensureMembership } from '../../src/modules/identity/memberships.service.js';
import type { RoleDoc } from '../../src/modules/identity/roles.model.js';
import { findRoleByCode } from '../../src/modules/identity/roles.service.js';
import { UserModel, type UserDoc, type UserStatus } from '../../src/modules/identity/users.model.js';
import type { OrganisationDoc, OrgType } from '../../src/modules/organisations/organisations.model.js';
import { findOrganisationById, findOrganisationByCode } from '../../src/modules/organisations/organisations.service.js';
import { seedCore } from '../../src/seed/core.js';

import { createAirportOrg, createTestOperator } from './fixtures.js';

export interface TestClaims {
  sub: string;
  email?: string;
  name?: string;
  email_verified?: boolean;
}

export function tokenFor(claims: TestClaims): string {
  return `test:${JSON.stringify(claims)}`;
}

export const fakeVerifyToken: TokenVerifier = async (token) => {
  if (!token.startsWith('test:')) throw new AppError('UNAUTHENTICATED', 'Invalid or expired token');
  let claims: unknown;
  try {
    claims = JSON.parse(token.slice(5));
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired token');
  }
  return principalFromClaims(claims as JWTPayload);
};

export interface AsUserOptions {
  orgType: OrgType;
  roleCode: string;
  email?: string;
  name?: string;
  /** Use an existing organisation instead of the default test one for the type. */
  orgId?: string;
  /** For ACO / AIRPORT organisations created on demand. */
  orgCode?: string;
  airportIata?: string;
  status?: UserStatus;
  /** false → no Keycloak sub yet (first-sign-in linking). Default true. */
  linked?: boolean;
}

export interface TestUser {
  user: UserDoc;
  org: OrganisationDoc;
  role: RoleDoc;
  token: string;
  headers: Record<string, string>;
  get(path: string): Test;
  post(path: string): Test;
  put(path: string): Test;
  patch(path: string): Test;
  delete(path: string): Test;
}

export interface TestApp {
  app: Express;
  env: Env;
  /** Unauthenticated client. */
  anon: request.Agent;
  asUser(options: AsUserOptions): Promise<TestUser>;
  close(): Promise<void>;
}

async function resetDatabase(): Promise<void> {
  await mongoose.connection.dropDatabase();
  await ensureIndexes();
}

export interface CreateTestAppOptions {
  /** Seed the vendored airports (default true; the default ACO lives at DEL). */
  airports?: boolean;
}

/** Fresh database, core seed, app with the fake verifier. Call in `beforeAll`. */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const env = loadEnv();
  initLogger({ level: env.LOG_LEVEL, pretty: false });
  if (!isDbConnected()) await connectDb(env.MONGO_URI);
  await resetDatabase();
  await seedCore({ airports: options.airports ?? true });
  invalidateRbacCache();
  scheduler.reset();
  scheduler.configure({ enabled: false });

  const app = createApp({ env, verifyToken: fakeVerifyToken });

  async function resolveOrg(opts: AsUserOptions): Promise<OrganisationDoc> {
    if (opts.orgId) {
      const org = await findOrganisationById(opts.orgId);
      if (!org) throw new Error(`Test organisation ${opts.orgId} not found`);
      return org;
    }
    switch (opts.orgType) {
      case 'ACFI': {
        const acfi = await findOrganisationByCode('ACFI');
        if (!acfi) throw new Error('ACFI organisation not seeded');
        return acfi;
      }
      case 'ACO':
        return createTestOperator({ code: opts.orgCode ?? 'TEST-ACO', airportIata: opts.airportIata ?? 'DEL' });
      case 'AIRPORT':
        return createAirportOrg({ code: opts.orgCode ?? 'TEST-AIRPORT', airportIata: opts.airportIata ?? 'DEL' });
    }
  }

  async function asUser(opts: AsUserOptions): Promise<TestUser> {
    const org = await resolveOrg(opts);
    const role = await findRoleByCode(opts.roleCode);
    if (!role) throw new Error(`Role ${opts.roleCode} not seeded`);
    const email = (opts.email ?? `${opts.roleCode}.${org.code}@test.csq`).toLowerCase();
    const sub = `kc-${email}`;
    const user = await UserModel.findOneAndUpdate(
      { email },
      {
        $setOnInsert: {
          email,
          name: opts.name ?? `${opts.roleCode} ${org.code}`,
          status: opts.status ?? 'ACTIVE',
          keycloakSub: opts.linked === false ? null : sub,
        },
      },
      { upsert: true, new: true },
    ).lean<UserDoc | null>();
    if (!user) throw new Error('Test user upsert failed');
    await ensureMembership({ userId: user._id, orgId: org._id, roleId: role._id });
    const token = tokenFor({ sub: user.keycloakSub ?? sub, email, name: user.name, email_verified: true });
    const headers = { Authorization: `Bearer ${token}`, 'x-csq-org': idString(org._id) };
    const client = request(app);
    return {
      user,
      org,
      role,
      token,
      headers,
      get: (path) => client.get(path).set(headers),
      post: (path) => client.post(path).set(headers),
      put: (path) => client.put(path).set(headers),
      patch: (path) => client.patch(path).set(headers),
      delete: (path) => client.delete(path).set(headers),
    };
  }

  return {
    app,
    env,
    anon: request.agent(app),
    asUser,
    close: async () => {
      await disconnectDb();
    },
  };
}
