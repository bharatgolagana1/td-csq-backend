import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { MembershipModel } from '../src/modules/identity/memberships.model.js';
import { UserModel } from '../src/modules/identity/users.model.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import { registerMarketShareFreezeCheck } from '../src/modules/organisations/market-share.service.js';
import { registerCustomerCounter } from '../src/modules/organisations/operators.service.js';
import { findOrganisationByCode } from '../src/modules/organisations/organisations.service.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, createTestOperator, expectError, grantTasks, operatorPayload } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let del: string;
let bom: string;

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  del = await airportIdByIata('DEL');
  bom = await airportIdByIata('BOM');
});
afterAll(() => t.close());

describe('POST /operators', () => {
  let operatorId: string;

  it('creates the organisation, the INVITED admin, the ACO_ADMIN membership, the share, the invite and the audit row', async () => {
    const res = await superAdmin.post('/api/v1/operators').send(operatorPayload(del));
    expect(res.status).toBe(201);
    const op = res.body.data;
    operatorId = op.id;
    expect(op).toMatchObject({
      code: 'DEL-CARGO',
      name: 'Delhi Cargo Terminal',
      airport: { id: del, iata: 'DEL', name: 'Indira Gandhi International Airport' },
      operations: { domestic: true, international: true },
      status: 'ACTIVE',
      createdVia: 'ADMIN',
      memberCount: 1,
      customerCount: 0,
      currentShare: 100,
    });
    expect(op.approvedAt).toBeTruthy();

    const admin = await UserModel.findOne({ email: 'asha.rao@delcargo.test' }).lean();
    expect(admin?.status).toBe('INVITED');
    expect(admin?.keycloakSub).toBeNull();
    const membership = await MembershipModel.findOne({ userId: admin!._id, orgId: operatorId }).lean();
    expect(membership?.status).toBe('ACTIVE');

    const mail = await NotificationModel.findOne({ to: 'asha.rao@delcargo.test' }).lean();
    expect(mail?.template).toBe('account-invited');
    expect(mail?.status).toBe('SENT');
    expect(mail?.body).toContain('Delhi Cargo Terminal');
    expect(idString(mail!.refs.acoId!)).toBe(operatorId);

    const audit = await AuditModel.findOne({ action: 'operator.created', entityId: operatorId }).lean();
    expect(audit).not.toBeNull();
    expect(idString(audit!.orgId!)).toBe(operatorId);
    expect(idString(audit!.actorOrgId!)).toBe(idString(superAdmin.org._id));
    expect((audit!.after as { admin: { email: string } }).admin.email).toBe('asha.rao@delcargo.test');
  });

  it('rejects a duplicate code, an unknown airport and invalid fields', async () => {
    expectError(await superAdmin.post('/api/v1/operators').send(operatorPayload(del)), 409, 'CONFLICT');
    const airport = await superAdmin.post('/api/v1/operators').send(operatorPayload('0123456789abcdef01234567', { code: 'X-1' }));
    expect(expectError(airport, 400, 'VALIDATION').message).toBe('Unknown airport');
    const pincode = await superAdmin.post('/api/v1/operators').send(
      operatorPayload(del, { code: 'X-2', address: { line1: 'a', city: 'b', state: 'c', pincode: '12' } }),
    );
    expectError(pincode, 400, 'VALIDATION');
    expectError(await superAdmin.post('/api/v1/operators').send(operatorPayload(del, { code: 'X-3', marketSharePct: 120 })), 400, 'VALIDATION');
  });

  it('reuses an existing user as admin instead of failing', async () => {
    const res = await superAdmin.post('/api/v1/operators').send(
      operatorPayload(del, {
        code: 'DEL-TWO',
        name: 'Delhi Two',
        admin: { name: 'Asha Rao', email: 'ASHA.RAO@delcargo.test', phone: '+91 1' },
        marketSharePct: 40,
        shares: [{ acoId: operatorId, sharePct: 60 }],
      }),
    );
    expect(res.status).toBe(201);
    expect(await UserModel.countDocuments({ email: 'asha.rao@delcargo.test' })).toBe(1);
    expect(await MembershipModel.countDocuments({ orgId: res.body.data.id })).toBe(1);
  });

  it('exposes the customer-count hook point', async () => {
    registerCustomerCounter(async (ids) => new Map(ids.map((id) => [id, id === operatorId ? 7 : 0])));
    try {
      const res = await superAdmin.get(`/api/v1/operators/${operatorId}`);
      expect(res.body.data.customerCount).toBe(7);
      const list = await superAdmin.get('/api/v1/operators?q=two');
      expect(list.body.data[0].customerCount).toBe(0);
    } finally {
      registerCustomerCounter(async () => new Map());
    }
  });

  it('lists with filters and sort; patches; deactivates once', async () => {
    const list = await superAdmin.get('/api/v1/operators?airportId=' + del + '&status=ACTIVE&sort=-code');
    expect((list.body.data as { code: string }[]).map((op) => op.code)).toEqual(['DEL-TWO', 'DEL-CARGO']);

    const patched = await superAdmin.patch(`/api/v1/operators/${operatorId}`).send({ name: 'Delhi Cargo Terminal Ltd', operations: { domestic: true, international: false }, airportId: bom });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ name: 'Delhi Cargo Terminal Ltd', operations: { domestic: true, international: false }, airport: { iata: 'BOM' } });
    expect(await AuditModel.countDocuments({ action: 'operator.updated', entityId: operatorId })).toBe(1);
    await superAdmin.patch(`/api/v1/operators/${operatorId}`).send({ airportId: del });

    const off = await superAdmin.post(`/api/v1/operators/${operatorId}/deactivate`);
    expect(off.body.data.status).toBe('INACTIVE');
    expectError(await superAdmin.post(`/api/v1/operators/${operatorId}/deactivate`), 412, 'PRECONDITION_FAILED');
    expect(await AuditModel.countDocuments({ action: 'operator.deactivated', entityId: operatorId })).toBe(1);
    expectError(await superAdmin.get('/api/v1/operators/0123456789abcdef01234567'), 404, 'NOT_FOUND');
    expectError(await superAdmin.get('/api/v1/operators/nope'), 400, 'VALIDATION');
  });
});

describe('market share', () => {
  let a: string;
  let b: string;
  let elsewhere: string;

  beforeAll(async () => {
    a = idString((await createTestOperator({ code: 'MS-A', airportIata: 'BLR' }))._id);
    b = idString((await createTestOperator({ code: 'MS-B', airportIata: 'BLR' }))._id);
    elsewhere = idString((await createTestOperator({ code: 'MS-C', airportIata: 'HYD' }))._id);
  });

  it('rejects a set that does not total 100 and operators from other airports', async () => {
    const blr = await airportIdByIata('BLR');
    const short = await superAdmin.put(`/api/v1/airports/${blr}/market-share`).send({ entries: [{ acoId: a, sharePct: 60 }, { acoId: b, sharePct: 30 }] });
    const error = expectError(short, 400, 'VALIDATION');
    expect((error.details as { issues: { message: string }[] }).issues[0]!.message).toBe('Market shares must total 100 (got 90)');

    const foreign = await superAdmin.put(`/api/v1/airports/${blr}/market-share`).send({ entries: [{ acoId: a, sharePct: 50 }, { acoId: elsewhere, sharePct: 50 }] });
    expect(JSON.stringify(expectError(foreign, 400, 'VALIDATION').details)).toContain('does not operate at this airport');

    const dup = await superAdmin.put(`/api/v1/airports/${blr}/market-share`).send({ entries: [{ acoId: a, sharePct: 50 }, { acoId: a, sharePct: 50 }] });
    expect(JSON.stringify(expectError(dup, 400, 'VALIDATION').details)).toContain('listed twice');
  });

  it('saves a valid set within tolerance, reads it back and audits', async () => {
    const blr = await airportIdByIata('BLR');
    const res = await superAdmin.put(`/api/v1/airports/${blr}/market-share`).send({ entries: [{ acoId: a, sharePct: 66.67 }, { acoId: b, sharePct: 33.33 }], note: 'FY26' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ airportId: blr, cycleId: null, total: 100, frozen: false });
    expect((res.body.data.entries as { acoId: string; code: string; sharePct: number }[]).map((e) => e.code)).toEqual(['MS-A', 'MS-B']);

    const get = await superAdmin.get(`/api/v1/airports/${blr}/market-share`);
    expect(get.body.data.entries).toHaveLength(2);
    const operators = await superAdmin.get(`/api/v1/operators?airportId=${blr}`);
    expect((operators.body.data as { code: string; currentShare: number }[]).find((op) => op.code === 'MS-A')?.currentShare).toBe(66.67);

    const audit = await AuditModel.findOne({ action: 'marketshare.updated', entityId: blr }).lean();
    expect((audit?.before as { total: number }).total).toBe(0);
    expect((audit?.after as { total: number }).total).toBe(100);

    // Replacing the set drops operators that are no longer listed.
    const replaced = await superAdmin.put(`/api/v1/airports/${blr}/market-share`).send({ entries: [{ acoId: a, sharePct: 100 }] });
    expect(replaced.body.data.entries).toHaveLength(1);
  });

  it('a cycle-scoped set is refused when the registered predicate says frozen', async () => {
    const blr = await airportIdByIata('BLR');
    const cycleId = '0123456789abcdef01234567';
    registerMarketShareFreezeCheck(async (id) => id === cycleId);
    try {
      const frozen = await superAdmin.put(`/api/v1/airports/${blr}/market-share`).send({ cycleId, entries: [{ acoId: a, sharePct: 100 }] });
      expectError(frozen, 412, 'PRECONDITION_FAILED');
      const view = await superAdmin.get(`/api/v1/airports/${blr}/market-share?cycleId=${cycleId}`);
      expect(view.body.data).toMatchObject({ cycleId, frozen: true, entries: [] });

      const other = await superAdmin.put(`/api/v1/airports/${blr}/market-share`).send({ cycleId: 'abcdef0123456789abcdef01', entries: [{ acoId: a, sharePct: 100 }] });
      expect(other.status).toBe(200);
      expect(other.body.data.frozen).toBe(false);
      // The current (cycle-less) set is never frozen.
      const current = await superAdmin.put(`/api/v1/airports/${blr}/market-share`).send({ cycleId: null, entries: [{ acoId: a, sharePct: 100 }] });
      expect(current.status).toBe(200);
    } finally {
      registerMarketShareFreezeCheck(async () => false);
    }
  });

  it('operators see their own airport only (404 elsewhere); the airport detail embeds operators and shares', async () => {
    await grantTasks('ACO_ADMIN', ['marketshare.view', 'airports.view']);
    const acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: a });
    const blr = await airportIdByIata('BLR');
    expect((await acoAdmin.get(`/api/v1/airports/${blr}/market-share`)).status).toBe(200);
    expectError(await acoAdmin.get(`/api/v1/airports/${del}/market-share`), 404, 'NOT_FOUND');
    expectError(await acoAdmin.put(`/api/v1/airports/${blr}/market-share`).send({ entries: [{ acoId: a, sharePct: 100 }] }), 403, 'FORBIDDEN');

    const detail = await superAdmin.get(`/api/v1/airports/${blr}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.iata).toBe('BLR');
    expect((detail.body.data.operators as { code: string }[]).map((op) => op.code).sort()).toEqual(['MS-A', 'MS-B']);
    expect(detail.body.data.marketShare.total).toBe(100);
  });
});

interface Issue {
  path: string;
  message: string;
}

function issuesOf(res: Parameters<typeof expectError>[0]): Issue[] {
  return (expectError(res, 400, 'VALIDATION').details as { issues: Issue[] }).issues;
}

describe('POST /operators keeps the airport at 100 %', () => {
  let maa: string;
  let one: string;
  let two: string;
  const join = (code: string, overrides: Record<string, unknown>) =>
    superAdmin.post('/api/v1/operators').send(
      operatorPayload(maa, { code, name: `${code} Cargo`, admin: { name: 'Admin', email: `admin@${code.toLowerCase()}.test`, phone: '+91 1' }, ...overrides }),
    );
  const sharesAt = async (): Promise<[string, number][]> => {
    const res = await superAdmin.get(`/api/v1/airports/${maa}/market-share`);
    return (res.body.data.entries as { code: string; sharePct: number }[]).map((e) => [e.code, e.sharePct]);
  };

  beforeAll(async () => {
    maa = await airportIdByIata('MAA');
  });

  it('the first operator at an airport must hold 100; nothing is created otherwise', async () => {
    expect(issuesOf(await join('MAA-ONE', { marketSharePct: 60 }))).toEqual([
      { path: 'marketSharePct', message: 'MAA-ONE is the only active operator at MAA, so its share must be 100 (got 60)' },
    ]);
    expect(issuesOf(await join('MAA-ONE', { marketSharePct: undefined }))[0]?.message).toBe('MAA-ONE is the only active operator at MAA, so its share must be 100 (got 0)');
    expect(await findOrganisationByCode('MAA-ONE')).toBeNull();

    const res = await join('MAA-ONE', { marketSharePct: 100 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    one = res.body.data.id;
    expect(await sharesAt()).toEqual([['MAA-ONE', 100]]);
    const audit = await AuditModel.findOne({ action: 'marketshare.updated', entityId: maa }).lean();
    expect(audit?.before).toMatchObject({ total: 0, entries: [] });
    expect(audit?.after).toMatchObject({ total: 100, entries: [{ code: 'MAA-ONE', sharePct: 100 }] });
  });

  it('a later operator must bring the whole set to 100: over, under, missing, foreign and duplicate operators are named', async () => {
    expect(issuesOf(await join('MAA-TWO', { marketSharePct: 30 }))).toEqual([
      { path: 'marketSharePct', message: 'Market shares at MAA must total 100 (got 130: 100 for the 1 active operator + 30 for MAA-TWO)' },
    ]);
    expect(issuesOf(await join('MAA-TWO', { marketSharePct: 30, shares: [{ acoId: one, sharePct: 60 }] }))).toEqual([
      { path: 'shares', message: 'Market shares at MAA must total 100 (got 90: 60 for the 1 active operator + 30 for MAA-TWO)' },
    ]);
    expect(issuesOf(await join('MAA-TWO', { marketSharePct: 100, shares: [] }))).toEqual([
      { path: 'shares', message: 'No share given for MAA-ONE (MAA-ONE Cargo), active at MAA' },
    ]);
    const foreign = idString((await createTestOperator({ code: 'GOI-ELSE', airportIata: 'GOI' }))._id);
    const mixed = issuesOf(
      await join('MAA-TWO', {
        marketSharePct: 30,
        shares: [
          { acoId: one, sharePct: 35 },
          { acoId: one, sharePct: 35 },
          { acoId: foreign, sharePct: 0 },
          { acoId: '0123456789abcdef01234567', sharePct: 0 },
        ],
      }),
    );
    expect(mixed).toEqual([
      { path: 'shares.1.acoId', message: 'Operator MAA-ONE is listed twice' },
      { path: 'shares.2.acoId', message: 'Operator GOI-ELSE does not operate at MAA' },
      { path: 'shares.3.acoId', message: 'Unknown operator 0123456789abcdef01234567' },
    ]);
    expect(await findOrganisationByCode('MAA-TWO')).toBeNull();
    expect(await sharesAt()).toEqual([['MAA-ONE', 100]]);
  });

  it('with the others rebalanced the set is written whole (within the 0.01 tolerance) and audited', async () => {
    const res = await join('MAA-TWO', { marketSharePct: 33.33, shares: [{ acoId: one, sharePct: 66.66 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    two = res.body.data.id;
    expect(res.body.data.currentShare).toBe(33.33);
    expect(await sharesAt()).toEqual([
      ['MAA-ONE', 66.66],
      ['MAA-TWO', 33.33],
    ]);
    const audits = await AuditModel.find({ action: 'marketshare.updated', entityId: maa }).sort({ at: 1 }).lean();
    expect(audits).toHaveLength(2);
    expect(audits[1]?.after).toMatchObject({ total: 99.99 });
  });

  it('an inactive operator holds no share: it cannot be listed, and its old entry is dropped when the next operator joins', async () => {
    await superAdmin.post(`/api/v1/operators/${two}/deactivate`);
    const listed = issuesOf(await join('MAA-THREE', { marketSharePct: 50, shares: [{ acoId: one, sharePct: 25 }, { acoId: two, sharePct: 25 }] }));
    expect(listed).toEqual([{ path: 'shares.1.acoId', message: 'Operator MAA-TWO is INACTIVE; only active operators hold a share' }]);

    const res = await join('MAA-THREE', { marketSharePct: 50, shares: [{ acoId: one, sharePct: 50 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await sharesAt()).toEqual([
      ['MAA-ONE', 50],
      ['MAA-THREE', 50],
    ]);
  });
});

describe('GET /market-share/totals', () => {
  it('totals each listed airport in one call, in the order asked; unknown airports are left out', async () => {
    const [blr, hyd, goi] = await Promise.all([airportIdByIata('BLR'), airportIdByIata('HYD'), airportIdByIata('GOI')]);
    // BLR: MS-A holds 100 (the set above); HYD: MS-C without a share; GOI: nobody.
    const res = await superAdmin.get(`/api/v1/market-share/totals?airportIds=${blr},${goi},${hyd},${blr},0123456789abcdef01234567`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual([
      { airportId: blr, total: 100, entries: 1 },
      { airportId: goi, total: 0, entries: 0 },
      { airportId: hyd, total: 0, entries: 0 },
    ]);
  });

  it('validates the list', async () => {
    expectError(await superAdmin.get('/api/v1/market-share/totals'), 400, 'VALIDATION');
    expectError(await superAdmin.get('/api/v1/market-share/totals?airportIds='), 400, 'VALIDATION');
    expectError(await superAdmin.get('/api/v1/market-share/totals?airportIds=nope'), 400, 'VALIDATION');
    const many = Array.from({ length: 301 }, (_, i) => i.toString(16).padStart(24, '0')).join(',');
    expectError(await superAdmin.get(`/api/v1/market-share/totals?airportIds=${many}`), 400, 'VALIDATION');
  });

  it('needs marketshare.view, and an operator only gets its own airport', async () => {
    const [blr, hyd] = await Promise.all([airportIdByIata('BLR'), airportIdByIata('HYD')]);
    const user = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_USER', orgCode: 'TOTALS-ACO', airportIata: 'BLR' });
    expectError(await user.get(`/api/v1/market-share/totals?airportIds=${blr}`), 403, 'FORBIDDEN');
    await grantTasks('ACO_USER', ['marketshare.view']);
    const own = await user.get(`/api/v1/market-share/totals?airportIds=${hyd},${blr}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data).toEqual([{ airportId: blr, total: 100, entries: 1 }]);
  });
});
