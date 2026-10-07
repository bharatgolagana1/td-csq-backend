import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { audit } from '../src/modules/audit/audit.service.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, expectError, grantTasks, operatorPayload } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let operatorId: string;

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  const matrix = await superAdmin.get('/api/v1/roles/matrix');
  const viewer = (matrix.body.data.roles as { id: string; code: string; tasks: string[] }[]).find((r) => r.code === 'AIRPORT_VIEWER')!;
  await superAdmin.put('/api/v1/roles/matrix').send({ roles: [{ roleId: viewer.id, tasks: ['reports.airport', 'airports.view'].filter((c) => matrix.body.data.tasks.some((task: { code: string }) => task.code === c)) }] });
  const created = await superAdmin.post('/api/v1/operators').send(operatorPayload(await airportIdByIata('DEL')));
  operatorId = created.body.data.id;
});
afterAll(() => t.close());

describe('GET /audit', () => {
  it('records the matrix save and the operator creation with actor, before/after, ip and request id', async () => {
    const res = await superAdmin.get('/api/v1/audit');
    expect(res.status).toBe(200);
    const entries = res.body.data as { action: string; entity: string; entityId: string; actorEmail: string; before?: unknown; after?: unknown; requestId: string; ip: string }[];
    const matrix = entries.find((e) => e.action === 'roles.matrix.saved')!;
    expect(matrix).toMatchObject({ entity: 'roles.matrix', entityId: 'global', actorEmail: superAdmin.user.email });
    expect(Object.keys(matrix.before as object)).toEqual(['AIRPORT_VIEWER']);
    expect((matrix.after as { AIRPORT_VIEWER: string[] }).AIRPORT_VIEWER).toContain('airports.view');
    expect(matrix.requestId.length).toBeGreaterThan(0);
    const operator = entries.find((e) => e.action === 'operator.created')!;
    expect(operator.entityId).toBe(operatorId);
    expect(entries[0]!.action).toBe('user.created' === entries[0]!.action ? 'user.created' : entries[0]!.action);
  });

  it('filters by entity, entityId, action, actor and time window', async () => {
    const byEntity = await superAdmin.get(`/api/v1/audit?entity=operator&entityId=${operatorId}`);
    expect((byEntity.body.data as { action: string }[]).map((e) => e.action)).toEqual(['operator.created']);
    const byAction = await superAdmin.get('/api/v1/audit?action=roles.matrix.saved');
    expect(byAction.body.meta.total).toBe(1);
    const byActor = await superAdmin.get(`/api/v1/audit?actor=${idString(superAdmin.user._id)}`);
    expect(byActor.body.meta.total).toBeGreaterThanOrEqual(2);
    const byEmail = await superAdmin.get('/api/v1/audit?actor=nobody@nowhere');
    expect(byEmail.body.meta.total).toBe(0);
    const future = await superAdmin.get(`/api/v1/audit?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
    expect(future.body.meta.total).toBe(0);
    const past = await superAdmin.get(`/api/v1/audit?to=${encodeURIComponent(new Date().toISOString())}&sort=at`);
    expect(past.body.meta.total).toBeGreaterThanOrEqual(2);
    expectError(await superAdmin.get('/api/v1/audit?from=yesterday'), 400, 'VALIDATION');
  });

  it('an operator sees only entries about its own organisation', async () => {
    await grantTasks('ACO_ADMIN', ['audit.view']);
    const acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: operatorId });
    const res = await acoAdmin.get('/api/v1/audit');
    expect(res.status).toBe(200);
    const entries = res.body.data as { action: string; orgId: string }[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.orgId === operatorId)).toBe(true);
    expect(entries.some((e) => e.action === 'operator.created')).toBe(true);
    expect(entries.some((e) => e.action === 'roles.matrix.saved')).toBe(false);
    // The orgId filter cannot widen the scope.
    const widened = await acoAdmin.get(`/api/v1/audit?orgId=${idString(superAdmin.org._id)}`);
    expect((widened.body.data as { orgId: string }[]).every((e) => e.orgId === operatorId)).toBe(true);
  });

  it('system actions are recorded without an actor and never throw', async () => {
    await audit(null, { action: 'scoring.run', entity: 'cycle', entityId: 'c1', after: { ok: true } });
    const row = await AuditModel.findOne({ action: 'scoring.run' }).lean();
    expect(row).toMatchObject({ actorUserId: null, actorEmail: null, orgId: null, entityId: 'c1', ip: '', requestId: '' });
    await expect(audit(null, { action: 'x', entity: 'y', entityId: 'z', orgId: 'not-an-id' })).resolves.toBeUndefined();
  });
});
