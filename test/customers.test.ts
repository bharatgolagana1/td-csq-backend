import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../src/core/errors.js';
import { idString } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { CustomerImportModel } from '../src/modules/customers/customer-imports.model.js';
import { CustomerModel } from '../src/modules/customers/customers.model.js';
import {
  countByAco,
  countByAcos,
  emailsByAco,
  getCustomer,
  listEligible,
  markLastSampled,
} from '../src/modules/customers/customers.service.js';
import { CUSTOMER_CSV_HEADERS, customerCsvTemplate } from '../src/modules/customers/domain/csvTemplate.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, expectError, grantTasks } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let analyst: TestUser;
let adminA: TestUser;
let userA: TestUser;
let adminB: TestUser;
let acoA: string;
let acoB: string;
let del: string;

const CUSTOMERS = '/api/v1/customers';

function customerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Acme Logistics',
    contactPerson: 'Asha Rao',
    email: 'ops@acme.in',
    phone: '+91 98765 43210',
    type: 'FF',
    surveyType: 'BOTH',
    tags: ['priority'],
    ...overrides,
  };
}

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  analyst = await t.asUser({ orgType: 'ACFI', roleCode: 'ACFI_ANALYST' });
  adminA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'CUST-A', airportIata: 'DEL' });
  userA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_USER', orgCode: 'CUST-A', airportIata: 'DEL' });
  adminB = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'CUST-B', airportIata: 'BOM' });
  acoA = idString(adminA.org._id);
  acoB = idString(adminB.org._id);
  del = await airportIdByIata('DEL');
});
afterAll(() => t.close());

describe('POST /customers', () => {
  let acmeId: string;

  it('creates a customer with domain-normalised fields, the operator airport and an audit row', async () => {
    const res = await adminA.post(CUSTOMERS).send(
      customerPayload({ name: '  Acme   Logistics ', contactPerson: '', email: 'Ops@ACME.in', phone: '98765 43210', tags: ['Priority', 'priority', ' north '] }),
    );
    expect(res.status).toBe(201);
    acmeId = res.body.data.id;
    expect(res.body.data).toMatchObject({
      acoId: acoA,
      airportId: del,
      name: 'Acme Logistics',
      contactPerson: 'Acme Logistics',
      email: 'ops@acme.in',
      phone: '+919876543210',
      type: 'FF',
      surveyType: 'BOTH',
      status: 'ACTIVE',
      tags: ['Priority', 'north'],
      lastSampledCycleId: null,
      importBatchId: null,
    });
    const audit = await AuditModel.findOne({ action: 'customer.created', entityId: acmeId }).lean();
    expect(idString(audit!.orgId!)).toBe(acoA);
    expect((audit!.after as { email: string }).email).toBe('ops@acme.in');
  });

  it('refuses a second customer with the same e-mail in the operator (409 naming the holder) but not elsewhere', async () => {
    const dup = await adminA.post(CUSTOMERS).send(customerPayload({ name: 'Acme Again', email: 'OPS@acme.in' }));
    const error = expectError(dup, 409, 'CONFLICT');
    expect(error.details).toMatchObject({ customerId: acmeId, email: 'ops@acme.in' });
    const elsewhere = await adminB.post(CUSTOMERS).send(customerPayload({ name: 'Acme Mumbai' }));
    expect(elsewhere.status).toBe(201);
    expect(elsewhere.body.data.acoId).toBe(acoB);
  });

  it('validates the body through the domain rules and the role through the task', async () => {
    const phone = await adminA.post(CUSTOMERS).send(customerPayload({ email: 'p@x.in', phone: '12345' }));
    const issues = (expectError(phone, 400, 'VALIDATION').details as { issues: { path: string; message: string }[] }).issues;
    expect(issues).toEqual([{ path: 'phone', message: 'Phone must be a 10-digit Indian mobile or an international number starting with +' }]);
    expectError(await adminA.post(CUSTOMERS).send(customerPayload({ email: 'not-an-email' })), 400, 'VALIDATION');
    expectError(await adminA.post(CUSTOMERS).send(customerPayload({ email: 'x@y.in', type: 'XX' })), 400, 'VALIDATION');
    expectError(await adminA.post(CUSTOMERS).send(customerPayload({ email: 'x@y.in', extra: 1 })), 400, 'VALIDATION');
    expectError(await userA.post(CUSTOMERS).send(customerPayload({ email: 'x@y.in' })), 403, 'FORBIDDEN');
    // An ACO user may only name its own organisation; another operator's id is 404, never 403.
    expectError(await adminA.post(CUSTOMERS).send(customerPayload({ email: 'x@y.in', acoId: acoB })), 404, 'NOT_FOUND');
    expect((await adminA.post(CUSTOMERS).send(customerPayload({ name: 'Bharat Brokers', email: 'desk@bharat.in', type: 'CB', surveyType: 'DOMESTIC', tags: ['south'], acoId: acoA }))).status).toBe(201);
  });

  it('PLATFORM must name the operator and may create into any', async () => {
    expect(expectError(await superAdmin.post(CUSTOMERS).send(customerPayload({ email: 'hq@x.in' })), 400, 'VALIDATION').message).toBe('acoId is required for platform users');
    const unknown = await superAdmin.post(CUSTOMERS).send(customerPayload({ email: 'hq@x.in', acoId: '0123456789abcdef01234567' }));
    expect(expectError(unknown, 400, 'VALIDATION').message).toBe('Unknown operator');
    const res = await superAdmin.post(CUSTOMERS).send(customerPayload({ name: 'Cargo Kings', email: 'kings@cargo.in', surveyType: 'INTERNATIONAL', tags: [], acoId: acoA }));
    expect(res.status).toBe(201);
    expect(res.body.data.acoId).toBe(acoA);
    const audit = await AuditModel.findOne({ action: 'customer.created', entityId: res.body.data.id }).lean();
    expect(idString(audit!.orgId!)).toBe(acoA);
    expect(idString(audit!.actorOrgId!)).toBe(idString(superAdmin.org._id));
  });
});

describe('GET /customers', () => {
  it('an operator lists only its own directory, with filters, search and sort', async () => {
    const all = await adminA.get(CUSTOMERS);
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(3);
    expect((all.body.data as { name: string }[]).map((c) => c.name)).toEqual(['Acme Logistics', 'Bharat Brokers', 'Cargo Kings']);

    const names = async (qs: string): Promise<string[]> => ((await adminA.get(`${CUSTOMERS}?${qs}`)).body.data as { name: string }[]).map((c) => c.name);
    expect(await names('type=CB')).toEqual(['Bharat Brokers']);
    expect(await names('surveyType=INTERNATIONAL')).toEqual(['Cargo Kings']);
    expect(await names('surveyType=BOTH')).toEqual(['Acme Logistics']);
    expect(await names('status=INACTIVE')).toEqual([]);
    expect(await names('tag=SOUTH')).toEqual(['Bharat Brokers']);
    expect(await names('q=kings')).toEqual(['Cargo Kings']);
    expect(await names('q=desk@bharat')).toEqual(['Bharat Brokers']);
    expect(await names('q=asha')).toEqual(['Bharat Brokers', 'Cargo Kings']);
    expect(await names('sort=-name&pageSize=2')).toEqual(['Cargo Kings', 'Bharat Brokers']);
    expectError(await adminA.get(`${CUSTOMERS}?type=XX`), 400, 'VALIDATION');
    expectError(await adminA.get(`${CUSTOMERS}?sort=phone`), 400, 'VALIDATION');
    expectError(await adminA.get(`${CUSTOMERS}?acoId=${acoB}`), 404, 'NOT_FOUND');
  });

  it('PLATFORM sees every operator and can narrow to one; ACO_USER and the analyst may read', async () => {
    const all = await superAdmin.get(CUSTOMERS);
    expect(all.body.meta.total).toBe(4);
    const onlyB = await superAdmin.get(`${CUSTOMERS}?acoId=${acoB}`);
    expect((onlyB.body.data as { name: string }[]).map((c) => c.name)).toEqual(['Acme Mumbai']);
    expect((await userA.get(CUSTOMERS)).body.meta.total).toBe(3);
    expect((await analyst.get(CUSTOMERS)).body.meta.total).toBe(4);
  });

  it('gets one customer; another operator gets 404; an airport organisation has no directory', async () => {
    const acme = await CustomerModel.findOne({ email: 'ops@acme.in' }).lean();
    const id = idString(acme!._id);
    expect((await adminA.get(`${CUSTOMERS}/${id}`)).body.data.email).toBe('ops@acme.in');
    expect((await superAdmin.get(`${CUSTOMERS}/${id}`)).status).toBe(200);
    expectError(await adminB.get(`${CUSTOMERS}/${id}`), 404, 'NOT_FOUND');
    expectError(await adminA.get(`${CUSTOMERS}/0123456789abcdef01234567`), 404, 'NOT_FOUND');
    expectError(await adminA.get(`${CUSTOMERS}/nope`), 400, 'VALIDATION');

    await grantTasks('AIRPORT_ADMIN', ['customers.view']);
    const airportAdmin = await t.asUser({ orgType: 'AIRPORT', roleCode: 'AIRPORT_ADMIN', orgCode: 'AIRPORT-DEL', airportIata: 'DEL' });
    expectError(await airportAdmin.get(CUSTOMERS), 403, 'FORBIDDEN');
    expectError(await airportAdmin.get(`${CUSTOMERS}/${id}`), 403, 'FORBIDDEN');
  });
});

describe('PATCH /customers/:id, deactivate, reactivate', () => {
  let kingsId: string;
  let bharatId: string;

  beforeAll(async () => {
    kingsId = idString((await CustomerModel.findOne({ email: 'kings@cargo.in' }).lean())!._id);
    bharatId = idString((await CustomerModel.findOne({ email: 'desk@bharat.in' }).lean())!._id);
  });

  it('patches with normalisation, keeps e-mail unique and audits before/after', async () => {
    const res = await adminA.patch(`${CUSTOMERS}/${kingsId}`).send({ name: 'Cargo Kings Ltd', phone: '0091 91234 56789', tags: ['vip; north'], contactPerson: '' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Cargo Kings Ltd', phone: '+919123456789', tags: ['vip', 'north'], contactPerson: 'Cargo Kings Ltd' });
    const audit = await AuditModel.findOne({ action: 'customer.updated', entityId: kingsId }).lean();
    expect((audit!.before as { name: string }).name).toBe('Cargo Kings');
    expect((audit!.after as { name: string }).name).toBe('Cargo Kings Ltd');

    const taken = await adminA.patch(`${CUSTOMERS}/${kingsId}`).send({ email: 'OPS@acme.in' });
    expect(expectError(taken, 409, 'CONFLICT').details).toMatchObject({ email: 'ops@acme.in' });
    // The same e-mail as its own is not a conflict.
    expect((await adminA.patch(`${CUSTOMERS}/${kingsId}`).send({ email: 'KINGS@cargo.in' })).status).toBe(200);
    expectError(await adminB.patch(`${CUSTOMERS}/${kingsId}`).send({ name: 'Hijack' }), 404, 'NOT_FOUND');
    expectError(await userA.patch(`${CUSTOMERS}/${kingsId}`).send({ name: 'Nope' }), 403, 'FORBIDDEN');
    expectError(await adminA.patch(`${CUSTOMERS}/${kingsId}`).send({ status: 'INACTIVE' }), 400, 'VALIDATION');
  });

  it('deactivates once, reactivates once, and the list filter follows', async () => {
    const off = await adminA.post(`${CUSTOMERS}/${kingsId}/deactivate`);
    expect(off.body.data.status).toBe('INACTIVE');
    expectError(await adminA.post(`${CUSTOMERS}/${kingsId}/deactivate`), 412, 'PRECONDITION_FAILED');
    expect(await AuditModel.countDocuments({ action: 'customer.deactivated', entityId: kingsId })).toBe(1);
    expect(((await adminA.get(`${CUSTOMERS}?status=INACTIVE`)).body.data as { id: string }[]).map((c) => c.id)).toEqual([kingsId]);
    expectError(await adminB.post(`${CUSTOMERS}/${kingsId}/reactivate`), 404, 'NOT_FOUND');

    const on = await adminA.post(`${CUSTOMERS}/${bharatId}/deactivate`);
    expect(on.body.data.status).toBe('INACTIVE');
    const back = await adminA.post(`${CUSTOMERS}/${bharatId}/reactivate`);
    expect(back.body.data.status).toBe('ACTIVE');
    expectError(await adminA.post(`${CUSTOMERS}/${bharatId}/reactivate`), 412, 'PRECONDITION_FAILED');
    // Cargo Kings stays INACTIVE for the import test below.
  });
});

describe('import', () => {
  const messyCsv = [
    'Organisation Name,Contact,E-mail,Mobile No.,Stakeholder Type (FF/CB),Survey,Tags,Notes',
    'Acme Logistics,Asha Rao,OPS@ACME.IN,98765 43210,Freight Forwarder,Domestic,priority;vip,ignored column',
    'New Forwarder,Vikram Mehta,new@fwd.in,+91 91234 56789,FF,International,,',
    'Dup Row,Vikram Mehta,NEW@fwd.in,9123456789,FF,Both,,',
    'Bad Phone,Priya Nair,bad@phone.in,12345,CB,Domestic,,',
    'Cargo Kings Ltd,Rahul Verma,kings@cargo.in,91234 56789,FF,Intl,,',
    'Broker One,Meera Iyer,broker@one.in,09876500001,Customs Broker,Both,south,',
  ].join('\n');
  let importId: string;

  it('serves the template as a CSV download with two example rows', async () => {
    const res = await userA.get(`${CUSTOMERS}/import/template`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename="customers-template.csv"');
    expect(res.text).toBe(customerCsvTemplate({ sampleRows: 2 }));
    const lines = res.text.split('\r\n').filter((line) => line !== '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(CUSTOMER_CSV_HEADERS.join(','));
    expect(lines[1]).toContain('customer1@example.com');
    expect((await t.anon.get(`${CUSTOMERS}/import/template`)).status).toBe(401);
  });

  it('validates a multipart upload: messy headers, duplicates in file and against the directory, bad rows', async () => {
    const res = await adminA.post(`${CUSTOMERS}/import/validate`).attach('file', Buffer.from(messyCsv), 'messy.csv');
    expect(res.status).toBe(201);
    importId = res.body.data.importId;
    expect(res.body.data).toMatchObject({ acoId: acoA, fileName: 'messy.csv', status: 'VALIDATED', rows: 6, accepted: 4, rejected: 2 });
    expect(res.body.data.errors).toEqual([
      { row: 4, field: 'email', message: 'Duplicate of row 3 (new@fwd.in)' },
      { row: 5, field: 'phone', message: 'Phone must be a 10-digit Indian mobile or an international number starting with +' },
    ]);
    expect((res.body.data.preview as { action: string }[]).map((row) => row.action)).toEqual(['UPDATE', 'CREATE', 'REJECT', 'REJECT', 'UPDATE', 'CREATE']);
    expect(res.body.data.preview[0].data).toMatchObject({ email: 'ops@acme.in', phone: '+919876543210', type: 'FF', surveyType: 'DOMESTIC', tags: ['priority', 'vip'] });
    expect(res.body.data.headers).toMatchObject({ ignored: ['Notes'], missing: [] });
    expect(res.body.data.headers.matched).toMatchObject({ email: 'E-mail', type: 'Stakeholder Type (FF/CB)' });

    const stored = await CustomerImportModel.findById(importId).lean();
    expect(stored).toMatchObject({ status: 'VALIDATED', accepted: 4, result: null });
    expect(stored!.records.map((r) => `${r.row}:${r.action}`)).toEqual(['2:UPDATE', '3:CREATE', '6:UPDATE', '7:CREATE']);
    expect(idString(stored!.createdBy)).toBe(idString(adminA.user._id));
    // Nothing is written to the directory until the commit.
    expect(await CustomerModel.countDocuments({ acoId: adminA.org._id })).toBe(3);
  });

  it('another operator cannot commit it (404); the commit creates, updates, stamps the batch and audits', async () => {
    expectError(await adminB.post(`${CUSTOMERS}/import/${importId}/commit`), 404, 'NOT_FOUND');
    expectError(await adminA.post(`${CUSTOMERS}/import/0123456789abcdef01234567/commit`), 404, 'NOT_FOUND');
    expectError(await userA.post(`${CUSTOMERS}/import/${importId}/commit`), 403, 'FORBIDDEN');

    const res = await adminA.post(`${CUSTOMERS}/import/${importId}/commit`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ importId, status: 'COMMITTED', rows: 6, accepted: 4, rejected: 2, created: 2, updated: 2 });
    expect(res.body.data.committedAt).toBeTruthy();

    const acme = await CustomerModel.findOne({ acoId: adminA.org._id, email: 'ops@acme.in' }).lean();
    expect(acme).toMatchObject({ contactPerson: 'Asha Rao', surveyType: 'DOMESTIC', tags: ['priority', 'vip'], status: 'ACTIVE' });
    expect(idString(acme!.importBatchId!)).toBe(importId);
    // An UPDATE never silently reactivates a customer the operator switched off.
    const kings = await CustomerModel.findOne({ acoId: adminA.org._id, email: 'kings@cargo.in' }).lean();
    expect(kings).toMatchObject({ contactPerson: 'Rahul Verma', surveyType: 'INTERNATIONAL', status: 'INACTIVE' });
    const created = await CustomerModel.find({ acoId: adminA.org._id, email: { $in: ['new@fwd.in', 'broker@one.in'] } }).sort({ email: 1 }).lean();
    expect(created.map((c) => [c.name, c.phone, c.type, c.surveyType, c.status, idString(c.airportId)])).toEqual([
      ['Broker One', '+919876500001', 'CB', 'BOTH', 'ACTIVE', del],
      ['New Forwarder', '+919123456789', 'FF', 'INTERNATIONAL', 'ACTIVE', del],
    ]);
    expect(created.every((c) => idString(c.importBatchId!) === importId)).toBe(true);
    expect(await CustomerModel.countDocuments({ acoId: adminA.org._id })).toBe(5);

    const audit = await AuditModel.findOne({ action: 'customer.imported', entityId: importId }).lean();
    expect(idString(audit!.orgId!)).toBe(acoA);
    expect(audit!.after).toMatchObject({ fileName: 'messy.csv', rows: 6, accepted: 4, rejected: 2, created: 2, updated: 2 });
  });

  it('a second commit is 409 and changes nothing', async () => {
    const again = await adminA.post(`${CUSTOMERS}/import/${importId}/commit`);
    expect(expectError(again, 409, 'CONFLICT').details).toMatchObject({ importId });
    expect(await CustomerModel.countDocuments({ acoId: adminA.org._id })).toBe(5);
    expect(await AuditModel.countDocuments({ action: 'customer.imported', entityId: importId })).toBe(1);
  });

  it('accepts a text/csv body; an import with nothing accepted cannot be committed; empty and header-less files are rejected', async () => {
    const res = await adminA
      .post(`${CUSTOMERS}/import/validate?fileName=inline.csv`)
      .set('Content-Type', 'text/csv')
      .send('Name,Contact person,Email,Phone,Type,Survey type\nOnly Bad,X,bad,12,FF,DOMESTIC\n');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ fileName: 'inline.csv', rows: 1, accepted: 0, rejected: 1 });
    expect((res.body.data.errors as { field: string }[]).map((e) => e.field)).toEqual(['email', 'phone']);
    expectError(await adminA.post(`${CUSTOMERS}/import/${res.body.data.importId}/commit`), 412, 'PRECONDITION_FAILED');

    expectError(await adminA.post(`${CUSTOMERS}/import/validate`).set('Content-Type', 'text/csv').send('   '), 400, 'VALIDATION');
    const noHeader = await adminA.post(`${CUSTOMERS}/import/validate`).set('Content-Type', 'text/csv').send('Name,Email\nA,a@b.in\n');
    expect(noHeader.status).toBe(201);
    expect(noHeader.body.data).toMatchObject({ rows: 0, accepted: 0 });
    expect(noHeader.body.data.errors[0]).toMatchObject({ row: 1, field: 'header' });
    expect(noHeader.body.data.headers.missing).toEqual(['contactPerson', 'phone', 'type', 'surveyType']);
    expectError(await userA.post(`${CUSTOMERS}/import/validate`).set('Content-Type', 'text/csv').send(messyCsv), 403, 'FORBIDDEN');
  });

  it('PLATFORM imports into a named operator', async () => {
    const csv = 'Name,Contact person,Email,Phone,Type,Survey type\nPlatform Added,Ops,hq@added.in,9876501234,CB,BOTH\n';
    expectError(await superAdmin.post(`${CUSTOMERS}/import/validate`).set('Content-Type', 'text/csv').send(csv), 400, 'VALIDATION');
    const validated = await superAdmin.post(`${CUSTOMERS}/import/validate?acoId=${acoB}`).set('Content-Type', 'text/csv').send(csv);
    expect(validated.status).toBe(201);
    expect(validated.body.data).toMatchObject({ acoId: acoB, accepted: 1 });
    // The ACO that owns the import may commit it; the other ACO cannot see it.
    expectError(await adminA.post(`${CUSTOMERS}/import/${validated.body.data.importId}/commit`), 404, 'NOT_FOUND');
    const committed = await superAdmin.post(`${CUSTOMERS}/import/${validated.body.data.importId}/commit`);
    expect(committed.body.data).toMatchObject({ acoId: acoB, created: 1, updated: 0 });
    expect(await CustomerModel.countDocuments({ acoId: adminB.org._id })).toBe(2);
  });
});

describe('customer counter hook', () => {
  it('GET /operators/:id and the operator list carry the ACTIVE customer count', async () => {
    const expected = await CustomerModel.countDocuments({ acoId: adminA.org._id, status: 'ACTIVE' });
    expect(expected).toBe(4);
    const one = await superAdmin.get(`/api/v1/operators/${acoA}`);
    expect(one.body.data.customerCount).toBe(4);
    const list = await superAdmin.get('/api/v1/operators?q=CUST-');
    const counts = Object.fromEntries((list.body.data as { code: string; customerCount: number }[]).map((op) => [op.code, op.customerCount]));
    expect(counts).toEqual({ 'CUST-A': 4, 'CUST-B': 2 });
    expect(await countByAco(acoA)).toBe(4);
    expect(await countByAcos([acoA, acoB, '0123456789abcdef01234567'])).toEqual(new Map([[acoA, 4], [acoB, 2]]));
  });
});

describe('exported service functions', () => {
  it('getCustomer is scoped to the operator; emailsByAco covers every status', async () => {
    const acme = await CustomerModel.findOne({ acoId: adminA.org._id, email: 'ops@acme.in' }).lean();
    const id = idString(acme!._id);
    expect((await getCustomer(acoA, id)).email).toBe('ops@acme.in');
    await expect(getCustomer(acoB, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getCustomer(acoA, 'nope')).rejects.toBeInstanceOf(AppError);
    expect((await emailsByAco(acoA)).sort()).toEqual(['broker@one.in', 'desk@bharat.in', 'kings@cargo.in', 'new@fwd.in', 'ops@acme.in']);
  });

  it('listEligible applies the sampling domain: ACTIVE only, BOTH expands per survey type, participant types narrow', async () => {
    const both = await listEligible(acoA, 'BOTH');
    expect(both.map((e) => `${e.customer.name}:${e.surveyType}`)).toEqual([
      'Acme Logistics:DOMESTIC',
      'Bharat Brokers:DOMESTIC',
      'Broker One:DOMESTIC',
      'Broker One:INTERNATIONAL',
      'New Forwarder:INTERNATIONAL',
    ]);
    expect(both.every((e) => e.customer.status === 'ACTIVE' && e.key === `${e.customer.id}:${e.surveyType}`)).toBe(true);
    expect((await listEligible(acoA, 'INTERNATIONAL')).map((e) => e.customer.name)).toEqual(['Broker One', 'New Forwarder']);
    expect((await listEligible(acoA, 'BOTH', ['DOMESTIC'])).map((e) => e.surveyType)).toEqual(['DOMESTIC', 'DOMESTIC', 'DOMESTIC']);
    expect(await listEligible(acoB, 'DOMESTIC')).toHaveLength(2);
  });

  it('markLastSampled stamps the cycle on the operator customers only', async () => {
    const cycleId = '0123456789abcdef01234567';
    const [mine, theirs] = await Promise.all([
      CustomerModel.findOne({ acoId: adminA.org._id, email: 'ops@acme.in' }).lean(),
      CustomerModel.findOne({ acoId: adminB.org._id }).lean(),
    ]);
    expect(await markLastSampled(acoA, [idString(mine!._id), idString(theirs!._id)], cycleId)).toBe(1);
    expect((await adminA.get(`${CUSTOMERS}/${idString(mine!._id)}`)).body.data.lastSampledCycleId).toBe(cycleId);
    expect((await CustomerModel.findById(theirs!._id).lean())!.lastSampledCycleId).toBeNull();
    expect(await markLastSampled(acoA, [], cycleId)).toBe(0);
  });
});
