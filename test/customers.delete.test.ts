// Deleting a customer: who may, what disappears, and how sampling reacts —
// an open selection loses the customer, a locked sample of a running cycle
// refuses the delete, and adding the e-mail again brings the customer back.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { scopeForOrg, type RequestContext } from '../src/core/auth/session.js';
import { idString } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { lock } from '../src/modules/sampling/sampling.service.js';
import { seedSurveys } from '../src/seed/surveys.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, expectError } from './helpers/fixtures.js';

vi.mock('../src/modules/reports/index.js', async (importOriginal) => {
  try {
    return await importOriginal<Record<string, unknown>>();
  } catch {
    return { default: { name: 'reports', basePath: '/', tasks: [], routes: [] } };
  }
});

const DAY = 24 * 60 * 60 * 1000;
const CUSTOMERS = '/api/v1/customers';
const SAMPLING = '/api/v1/sampling/cycles';

function wall(days: number, time: string): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() + days * DAY),
  );
  return `${date}T${time}`;
}

function contextOf(as: TestUser): RequestContext {
  const org = { id: idString(as.org._id), type: as.org.type, airportId: as.org.airportId ? idString(as.org.airportId) : null };
  return {
    user: { id: idString(as.user._id), email: as.user.email, name: as.user.name, status: as.user.status },
    org: { ...org, code: as.org.code, name: as.org.name },
    role: { id: idString(as.role._id), code: as.role.code, scope: as.role.scope },
    tasks: new Set<string>(),
    scope: scopeForOrg(org),
    requestId: `test-${as.role.code}`,
    ip: '127.0.0.1',
  };
}

let t: TestApp;
let superAdmin: TestUser;
let acoAdmin: TestUser;
let acoUser: TestUser;
let acoId: string;
let cycleId: string;

async function createCustomer(body: Record<string, unknown>): Promise<string> {
  const res = await acoAdmin.post(CUSTOMERS).send({ contactPerson: 'Contact', phone: '+91 98765 43210', type: 'FF', surveyType: 'DOMESTIC', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function selection(): Promise<{ selectedCount: number; customerIds: string[] }> {
  const res = await acoAdmin.get(`${SAMPLING}/${cycleId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const rows = res.body.data.selection as { customer: { id: string } | null }[];
  return { selectedCount: res.body.data.selectedCount as number, customerIds: rows.map((row) => row.customer?.id ?? '?') };
}

beforeAll(async () => {
  t = await createTestApp();
  await seedSurveys();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'ACFI Admin' });
  acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'DEL-CUST', airportIata: 'MAA', name: 'Kavya Iyer' });
  acoUser = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_USER', orgCode: 'DEL-CUST', airportIata: 'MAA' });
  acoId = idString(acoAdmin.org._id);
  const airportId = await airportIdByIata('MAA');
  const share = await superAdmin.put(`/api/v1/airports/${airportId}/market-share`).send({ entries: [{ acoId, sharePct: 100 }] });
  expect(share.status, JSON.stringify(share.body)).toBe(200);

  const created = await superAdmin.post('/api/v1/cycles').send({
    name: 'Delete Flow 2026',
    code: 'DEL-FLOW-1',
    type: 'DOMESTIC',
    sampling: { start: wall(-1, '00:00'), end: wall(10, '23:59') },
    assessment: { start: wall(11, '00:00'), end: wall(40, '23:59') },
    minSampleSize: 2,
    participatingAirportIds: [airportId],
    participatingAcoIds: [acoId],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  cycleId = created.body.data.id as string;
  const published = await superAdmin.post(`/api/v1/cycles/${cycleId}/publish`);
  expect(published.status, JSON.stringify(published.body)).toBe(200);
});
afterAll(() => t.close());

describe('DELETE /customers/:id', () => {
  it('needs customers.delete; the customer leaves the directory, its page and the eligible list, and is audited', async () => {
    const id = await createCustomer({ name: 'Coromandel Logistics', email: 'ops@coromandel.test' });

    expectError(await acoUser.delete(`${CUSTOMERS}/${id}`), 403, 'FORBIDDEN');

    const res = await acoAdmin.delete(`${CUSTOMERS}/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    const list = await acoAdmin.get(CUSTOMERS);
    expect((list.body.data as { id: string }[]).map((row) => row.id)).not.toContain(id);
    expectError(await acoAdmin.get(`${CUSTOMERS}/${id}`), 404, 'NOT_FOUND');
    expectError(await acoAdmin.delete(`${CUSTOMERS}/${id}`), 404, 'NOT_FOUND');
    expectError(await acoAdmin.patch(`${CUSTOMERS}/${id}`).send({ name: 'Renamed' }), 404, 'NOT_FOUND');

    const eligible = await acoAdmin.get(`${CUSTOMERS}/eligible?cycleId=${cycleId}`);
    expect(eligible.status, JSON.stringify(eligible.body)).toBe(200);
    expect((eligible.body.data as { customer: { id: string } }[]).map((entry) => entry.customer.id)).not.toContain(id);

    const audit = await AuditModel.findOne({ action: 'customer.deleted', entityId: id }).lean();
    expect(audit).toMatchObject({ entity: 'customer', before: { name: 'Coromandel Logistics', status: 'ACTIVE' } });
  });

  it('a deleted customer cannot be added to a selection by id', async () => {
    const id = await createCustomer({ name: 'Ghost Freight', email: 'ops@ghost.test' });
    expect((await acoAdmin.delete(`${CUSTOMERS}/${id}`)).status).toBe(204);
    const res = await acoAdmin.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [{ customerId: id, surveyType: 'DOMESTIC' }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.rejected).toMatchObject([{ customerId: id, reason: 'UNKNOWN_CUSTOMER' }]);
  });

  it('deleting a customer in a selection that is not locked drops it from the selection and the counter', async () => {
    const keep = await createCustomer({ name: 'Anna Salai Brokers', email: 'cha@annasalai.test', type: 'CB' });
    const drop = await createCustomer({ name: 'Marina Forwarders', email: 'ops@marina.test' });
    const add = await acoAdmin
      .put(`${SAMPLING}/${cycleId}/selection`)
      .send({ add: [{ customerId: keep, surveyType: 'DOMESTIC' }, { customerId: drop, surveyType: 'DOMESTIC' }] });
    expect(add.body.data.state.selectedCount).toBe(2);

    expect((await acoAdmin.delete(`${CUSTOMERS}/${drop}`)).status).toBe(204);
    expect(await selection()).toEqual({ selectedCount: 1, customerIds: [keep] });
    const participants = await superAdmin.get(`/api/v1/cycles/${cycleId}/participants`);
    expect(participants.body.data[0]).toMatchObject({ acoId, sampling: { selectedCount: 1 } });
  });

  it('a customer in a locked sample of a running cycle cannot be deleted', async () => {
    const second = await createCustomer({ name: 'Guindy Cargo', email: 'ops@guindy.test' });
    const add = await acoAdmin.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [{ customerId: second, surveyType: 'DOMESTIC' }] });
    expect(add.body.data.state.selectedCount).toBe(2);
    await lock(contextOf(acoAdmin), cycleId);

    const error = expectError(await acoAdmin.delete(`${CUSTOMERS}/${second}`), 412, 'PRECONDITION_FAILED');
    expect(error.message).toContain('locked sample of DEL-FLOW-1');
    expect((await acoAdmin.get(`${CUSTOMERS}/${second}`)).status).toBe(200);
    expect((await selection()).selectedCount).toBe(2);
    expect(await AuditModel.countDocuments({ action: 'customer.deleted', entityId: second })).toBe(0);
  });

  it('adding a deleted e-mail again restores that customer, active, with the new details', async () => {
    const id = await createCustomer({ name: 'Old Name Pvt Ltd', email: 'desk@comeback.test', tags: ['old'] });
    expect((await acoAdmin.post(`${CUSTOMERS}/${id}/deactivate`)).status).toBe(200);
    expect((await acoAdmin.delete(`${CUSTOMERS}/${id}`)).status).toBe(204);

    const res = await acoAdmin
      .post(CUSTOMERS)
      .send({ name: 'Comeback Logistics', contactPerson: 'R. Kumar', email: 'desk@comeback.test', phone: '+91 90000 00000', type: 'CB', surveyType: 'BOTH' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ id, name: 'Comeback Logistics', type: 'CB', surveyType: 'BOTH', status: 'ACTIVE', tags: [] });
    expect((await acoAdmin.get(`${CUSTOMERS}/${id}`)).status).toBe(200);
    expect(await AuditModel.findOne({ action: 'customer.restored', entityId: id }).lean()).toMatchObject({ after: { status: 'ACTIVE' } });
  });
});
