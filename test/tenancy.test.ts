import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, expectError, grantTasks } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let adminA: TestUser;
let userA: TestUser;
let adminB: TestUser;
let airportAdmin: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  adminA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'ACO-A', airportIata: 'DEL' });
  userA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_USER', orgCode: 'ACO-A', airportIata: 'DEL' });
  adminB = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'ACO-B', airportIata: 'BOM' });
  // Neither role has operators.view by default; grant it so the scope rule (not the task) is what the test exercises.
  await grantTasks('AIRPORT_ADMIN', ['operators.view']);
  await grantTasks('ACO_ADMIN', ['operators.view']);
  airportAdmin = await t.asUser({ orgType: 'AIRPORT', roleCode: 'AIRPORT_ADMIN', orgCode: 'AIRPORT-DEL', airportIata: 'DEL' });
});
afterAll(() => t.close());

describe('users', () => {
  it('an ACO admin lists only members of its own organisation, with memberships limited to it', async () => {
    const res = await adminA.get('/api/v1/users');
    expect(res.status).toBe(200);
    const users = res.body.data as { email: string; memberships: { orgId: string }[] }[];
    expect(users.map((user) => user.email).sort()).toEqual([adminA.user.email, userA.user.email].sort());
    expect(users.every((user) => user.memberships.every((m) => m.orgId === idString(adminA.org._id)))).toBe(true);
    expect(res.body.meta.total).toBe(2);
  });

  it('PLATFORM lists everyone and can filter by orgId', async () => {
    const all = await superAdmin.get('/api/v1/users');
    expect(all.body.meta.total).toBeGreaterThanOrEqual(5);
    const onlyB = await superAdmin.get(`/api/v1/users?orgId=${idString(adminB.org._id)}`);
    expect((onlyB.body.data as { email: string }[]).map((user) => user.email)).toEqual([adminB.user.email]);
  });

  it('cross-organisation writes are 404, never 403', async () => {
    expectError(await adminA.patch(`/api/v1/users/${idString(adminB.user._id)}`).send({ name: 'Hijack' }), 404, 'NOT_FOUND');
    const create = await adminA
      .post('/api/v1/users')
      .send({ name: 'Sneaky', email: 'sneaky@test.csq', orgId: idString(adminB.org._id), roleCode: 'ACO_USER' });
    expect(expectError(create, 404, 'NOT_FOUND').message).toBe('Organisation not found');
    expectError(
      await adminA.post(`/api/v1/users/${idString(adminB.user._id)}/memberships`).send({ orgId: idString(adminA.org._id), roleCode: 'ACO_USER' }),
      404,
      'NOT_FOUND',
    );
  });

  it('an ACO admin can invite into its own organisation only with ACO roles', async () => {
    const ok = await adminA.post('/api/v1/users').send({ name: 'Ravi', email: 'ravi@aco-a.test', orgId: idString(adminA.org._id), roleCode: 'ACO_USER' });
    expect(ok.status).toBe(201);
    const wrongScope = await adminA
      .post('/api/v1/users')
      .send({ name: 'Ravi 2', email: 'ravi2@aco-a.test', orgId: idString(adminA.org._id), roleCode: 'SUPER_ADMIN' });
    expectError(wrongScope, 400, 'VALIDATION');
  });
});

describe('operators', () => {
  it('an ACO sees only itself; another operator is 404', async () => {
    const list = await adminA.get('/api/v1/operators');
    expect(list.status).toBe(200);
    expect((list.body.data as { code: string }[]).map((op) => op.code)).toEqual(['ACO-A']);
    expect((await adminA.get(`/api/v1/operators/${idString(adminA.org._id)}`)).status).toBe(200);
    expectError(await adminA.get(`/api/v1/operators/${idString(adminB.org._id)}`), 404, 'NOT_FOUND');
  });

  it('PLATFORM sees every operator and can filter by airport', async () => {
    const all = await superAdmin.get('/api/v1/operators');
    expect((all.body.data as { code: string }[]).map((op) => op.code).sort()).toEqual(['ACO-A', 'ACO-B']);
    const bom = await superAdmin.get(`/api/v1/operators?airportId=${await airportIdByIata('BOM')}`);
    expect((bom.body.data as { code: string; airport: { iata: string } }[]).map((op) => op.airport.iata)).toEqual(['BOM']);
  });

  it('an airport organisation sees the operators at its airport only', async () => {
    const res = await airportAdmin.get('/api/v1/operators');
    expect(res.status).toBe(200);
    expect((res.body.data as { code: string }[]).map((op) => op.code)).toEqual(['ACO-A']);
    expectError(await airportAdmin.get(`/api/v1/operators/${idString(adminB.org._id)}`), 404, 'NOT_FOUND');
  });

  it('/me reports the airport scope', async () => {
    const me = await airportAdmin.get('/api/v1/me');
    expect(me.body.data.active.scope).toEqual({ kind: 'AIRPORT', airportId: await airportIdByIata('DEL') });
  });
});
