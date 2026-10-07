import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { MembershipModel } from '../src/modules/identity/memberships.model.js';
import { UserModel } from '../src/modules/identity/users.model.js';
import { hashToken } from '../src/modules/invitations/domain/token.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import { OnboardingLinkModel } from '../src/modules/onboarding/onboarding-links.model.js';
import { registrationRateLimit } from '../src/modules/onboarding/onboarding.ratelimit.js';
import { RegistrationModel } from '../src/modules/onboarding/registrations.model.js';
import { setCurrentShare } from '../src/modules/organisations/market-share.service.js';
import { findOrganisationByCode } from '../src/modules/organisations/organisations.service.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, createTestOperator, expectError, grantTasks } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let analyst: TestUser;
let del: string;
let bom: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // well-formed (43 base64url chars), never issued

function registrationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organisation: {
      name: 'Gateway Cargo Services',
      legalName: 'Gateway Cargo Services Pvt Ltd',
      address: { line1: 'Cargo Complex, Gate 4', line2: null, city: 'New Delhi', state: 'Delhi', pincode: '110037' },
      contact: { name: 'Front Desk', email: 'desk@gateway.test', phone: '+91 11 4000 0000' },
    },
    admin: { name: 'Meera Nair', email: 'Meera.Nair@gateway.test', phone: '+91 98111 11111' },
    operations: { domestic: true, international: false },
    marketSharePct: 40,
    ...overrides,
  };
}

async function createLink(body: Record<string, unknown>): Promise<{ id: string; token: string; url: string }> {
  const res = await superAdmin.post('/api/v1/onboarding/links').send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const url = res.body.data.url as string;
  return { id: res.body.data.id as string, token: url.split('/register/')[1]!, url };
}

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  // An ACFI member without onboarding.review: must not be notified of submissions.
  analyst = await t.asUser({ orgType: 'ACFI', roleCode: 'ACFI_ANALYST', name: 'Read Only' });
  del = await airportIdByIata('DEL');
  bom = await airportIdByIata('BOM');
  // DEL already has one operator holding 60 %, so a 40 % request fits exactly.
  const existing = await createTestOperator({ code: 'DEL-EXISTING', airportIata: 'DEL' });
  await setCurrentShare({ airportId: existing.airportId!, acoId: existing._id, sharePct: 60, setBy: null });
});
beforeEach(() => {
  registrationRateLimit.reset();
});
afterAll(() => t.close());

describe('onboarding links', () => {
  let linkId: string;
  let token: string;

  it('creates a link: raw token only in the response, hash in the database, 14-day expiry, audit row', async () => {
    const created = await createLink({ orgType: 'ACO', airportId: del, note: 'Gateway Cargo' });
    linkId = created.id;
    token = created.token;
    expect(created.url).toBe(`${t.env.PUBLIC_WEB_URL}/register/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const res = await superAdmin.get('/api/v1/onboarding/links');
    const [link] = res.body.data as Record<string, unknown>[];
    expect(link).toMatchObject({
      id: linkId,
      orgType: 'ACO',
      airport: { id: del, iata: 'DEL' },
      createdBy: { id: idString(superAdmin.user._id), name: 'Platform Admin' },
      usedAt: null,
      registrationId: null,
      note: 'Gateway Cargo',
      status: 'OPEN',
    });
    expect(link).not.toHaveProperty('url');
    expect(link).not.toHaveProperty('tokenHash');
    expect(Math.abs(new Date(link!['expiresAt'] as string).getTime() - (Date.now() + 14 * DAY_MS))).toBeLessThan(60_000);

    const doc = await OnboardingLinkModel.findById(linkId).lean();
    expect(doc?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(doc)).not.toContain(token);
    expect(await AuditModel.countDocuments({ action: 'onboarding.link.created', entityId: linkId })).toBe(1);
  });

  it('validates the body: airport required and known, org type ACO|AIRPORT, expiry 1-90 days', async () => {
    expectError(await superAdmin.post('/api/v1/onboarding/links').send({ orgType: 'ACO' }), 400, 'VALIDATION');
    const unknown = await superAdmin.post('/api/v1/onboarding/links').send({ orgType: 'ACO', airportId: '0123456789abcdef01234567' });
    expect(expectError(unknown, 400, 'VALIDATION').message).toBe('Unknown airport');
    expectError(await superAdmin.post('/api/v1/onboarding/links').send({ orgType: 'ACFI', airportId: del }), 400, 'VALIDATION');
    expectError(await superAdmin.post('/api/v1/onboarding/links').send({ orgType: 'ACO', airportId: del, expiresInDays: 0 }), 400, 'VALIDATION');
    expectError(await superAdmin.post('/api/v1/onboarding/links').send({ orgType: 'ACO', airportId: del, expiresInDays: 91 }), 400, 'VALIDATION');
  });

  it('lists with status, orgType and q filters; an expired link reports EXPIRED and its page is 410', async () => {
    const expiring = await createLink({ orgType: 'AIRPORT', airportId: bom, expiresInDays: 1, note: 'Mumbai airport org' });
    await OnboardingLinkModel.updateOne({ _id: expiring.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const expired = await superAdmin.get('/api/v1/onboarding/links?status=EXPIRED');
    expect((expired.body.data as { id: string; status: string }[]).map((l) => [l.id, l.status])).toEqual([[expiring.id, 'EXPIRED']]);
    const open = await superAdmin.get('/api/v1/onboarding/links?status=OPEN');
    expect((open.body.data as { id: string }[]).map((l) => l.id)).toEqual([linkId]);
    const airports = await superAdmin.get('/api/v1/onboarding/links?orgType=AIRPORT');
    expect(airports.body.meta.total).toBe(1);
    expect((await superAdmin.get('/api/v1/onboarding/links?q=mumbai')).body.meta.total).toBe(1);
    expect((await superAdmin.get('/api/v1/onboarding/links?sort=expiresAt')).body.data[0].id).toBe(expiring.id);
    expectError(await superAdmin.get('/api/v1/onboarding/links?sort=tokenHash'), 400, 'VALIDATION');

    expectError(await t.anon.get(`/api/v1/public/onboarding/${expiring.token}`), 410, 'LINK_EXPIRED');
    expectError(await t.anon.post(`/api/v1/public/onboarding/${expiring.token}`).send(registrationPayload({ marketSharePct: undefined })), 410, 'LINK_EXPIRED');
  });

  it('deletes an unused link (then its page is 404); deleting again is 404', async () => {
    const extra = await createLink({ orgType: 'ACO', airportId: del });
    expect((await t.anon.get(`/api/v1/public/onboarding/${extra.token}`)).status).toBe(200);
    expect((await superAdmin.delete(`/api/v1/onboarding/links/${extra.id}`)).status).toBe(204);
    expectError(await t.anon.get(`/api/v1/public/onboarding/${extra.token}`), 404, 'NOT_FOUND');
    expectError(await superAdmin.delete(`/api/v1/onboarding/links/${extra.id}`), 404, 'NOT_FOUND');
    expectError(await superAdmin.delete('/api/v1/onboarding/links/nope'), 400, 'VALIDATION');
    expect(await AuditModel.countDocuments({ action: 'onboarding.link.deleted', entityId: extra.id })).toBe(1);
  });

  it('is a platform-only capability: an operator admin gets 403 without the task and 403 by scope with it', async () => {
    const acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'LINK-ACO' });
    expectError(await acoAdmin.get('/api/v1/onboarding/links'), 403, 'FORBIDDEN');
    await grantTasks('ACO_ADMIN', ['onboarding.links']);
    const scoped = expectError(await acoAdmin.post('/api/v1/onboarding/links').send({ orgType: 'ACO', airportId: del }), 403, 'FORBIDDEN');
    expect(scoped.message).toContain('PLATFORM');
    expectError(await acoAdmin.get('/api/v1/onboarding/links'), 403, 'FORBIDDEN');
  });
});

describe('public registration form', () => {
  let token: string;
  let linkId: string;
  let registrationId: string;

  beforeAll(async () => {
    const created = await createLink({ orgType: 'ACO', airportId: del, note: 'Gateway form' });
    token = created.token;
    linkId = created.id;
  });

  it('GET: unknown or malformed tokens are 404; a live link describes itself', async () => {
    expectError(await t.anon.get(`/api/v1/public/onboarding/${UNKNOWN_TOKEN}`), 404, 'NOT_FOUND');
    expectError(await t.anon.get('/api/v1/public/onboarding/not-a-token'), 404, 'NOT_FOUND');
    const res = await t.anon.get(`/api/v1/public/onboarding/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orgType: 'ACO', airport: { id: del, iata: 'DEL', name: 'Indira Gandhi International Airport' }, used: false });
    expect(typeof res.body.data.expiresAt).toBe('string');
  });

  it('POST: validates the form and refuses a market share on an AIRPORT link', async () => {
    const missingAdmin = expectError(await t.anon.post(`/api/v1/public/onboarding/${token}`).send(registrationPayload({ admin: undefined })), 400, 'VALIDATION');
    expect(JSON.stringify(missingAdmin.details)).toContain('admin');
    expectError(await t.anon.post(`/api/v1/public/onboarding/${token}`).send(registrationPayload({ marketSharePct: 120 })), 400, 'VALIDATION');
    expectError(await t.anon.post(`/api/v1/public/onboarding/${token}`).send(registrationPayload({ extra: true })), 400, 'VALIDATION');
    const badPin = registrationPayload();
    (badPin['organisation'] as { address: { pincode: string } }).address.pincode = '12';
    expectError(await t.anon.post(`/api/v1/public/onboarding/${token}`).send(badPin), 400, 'VALIDATION');
    expectError(await t.anon.post(`/api/v1/public/onboarding/${UNKNOWN_TOKEN}`).send(registrationPayload()), 404, 'NOT_FOUND');

    // The five refusals above used up this address's window (every attempt counts); start a fresh one.
    registrationRateLimit.reset();
    const airportLink = await createLink({ orgType: 'AIRPORT', airportId: bom });
    const share = expectError(await t.anon.post(`/api/v1/public/onboarding/${airportLink.token}`).send(registrationPayload()), 400, 'VALIDATION');
    expect(share.message).toContain('ACO');
    // Nothing was stored and the link stays open.
    expect(await RegistrationModel.countDocuments()).toBe(0);
    expect((await OnboardingLinkModel.findById(airportLink.id).lean())?.usedAt).toBeNull();
  });

  it('POST: stores SUBMITTED, marks the link used, e-mails the applicant and the reviewers, audits without an actor', async () => {
    const res = await t.anon.post(`/api/v1/public/onboarding/${token}`).send(registrationPayload());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    registrationId = res.body.data.registrationId;
    expect(Object.keys(res.body.data)).toEqual(['registrationId']);

    const doc = await RegistrationModel.findById(registrationId).lean();
    expect(doc).toMatchObject({
      orgType: 'ACO',
      status: 'SUBMITTED',
      organisation: { name: 'Gateway Cargo Services', legalName: 'Gateway Cargo Services Pvt Ltd' },
      admin: { name: 'Meera Nair', email: 'meera.nair@gateway.test' },
      operations: { domestic: true, international: false },
      marketSharePct: 40,
      reviewedBy: null,
      resultOrgId: null,
    });
    expect(idString(doc!.linkId!)).toBe(linkId);
    expect(idString(doc!.airportId)).toBe(del);

    const link = await OnboardingLinkModel.findById(linkId).lean();
    expect(link?.usedAt).toBeInstanceOf(Date);
    expect(idString(link!.registrationId!)).toBe(registrationId);

    const received = await NotificationModel.findOne({ to: 'meera.nair@gateway.test', template: 'registration-received' }).lean();
    expect(received?.status).toBe('SENT');
    expect(received?.body).toContain('Gateway Cargo Services');
    expect(received?.body).toContain('Indira Gandhi International Airport');

    const notice = await NotificationModel.findOne({ to: superAdmin.user.email, template: 'generic' }).lean();
    expect(notice?.subject).toBe('New registration request: Gateway Cargo Services (DEL)');
    expect(notice?.body).toContain(`Review registration: ${t.env.PUBLIC_WEB_URL}/registrations/${registrationId}`);
    expect(notice?.body).toContain('Requested market share: 40%');
    expect(idString(notice!.refs.userId!)).toBe(idString(superAdmin.user._id));
    expect(await NotificationModel.countDocuments({ to: analyst.user.email })).toBe(0);

    const audit = await AuditModel.findOne({ action: 'registration.submitted', entityId: registrationId }).lean();
    expect(audit?.actorUserId).toBeNull();
    expect(audit?.orgId).toBeNull();
    expect((audit?.after as { submittedFrom: { ip: string; requestId: string } }).submittedFrom.requestId).toBeTruthy();
  });

  it('a used link reads as used, refuses a second submission with 409 and cannot be revoked', async () => {
    const page = await t.anon.get(`/api/v1/public/onboarding/${token}`);
    expect(page.status).toBe(200);
    expect(page.body.data.used).toBe(true);
    expectError(await t.anon.post(`/api/v1/public/onboarding/${token}`).send(registrationPayload()), 409, 'CONFLICT');
    expect(await RegistrationModel.countDocuments({ linkId })).toBe(1);
    expectError(await superAdmin.delete(`/api/v1/onboarding/links/${linkId}`), 412, 'PRECONDITION_FAILED');
    const listed = await superAdmin.get('/api/v1/onboarding/links?status=USED');
    expect((listed.body.data as { id: string; registrationId: string }[]).map((l) => [l.id, l.registrationId])).toEqual([[linkId, registrationId]]);
  });

  it('rate-limits submissions per IP: every attempt counts, the sixth in the window is 429, other addresses are unaffected', async () => {
    // An empty body never reaches the handler (400 from validation) yet still counts: the limiter runs first.
    const from = (ip: string) => t.anon.post(`/api/v1/public/onboarding/${UNKNOWN_TOKEN}`).set('X-Forwarded-For', ip).send({});
    for (let i = 0; i < 5; i += 1) expectError(await from('203.0.113.9'), 400, 'VALIDATION');
    const limited = await from('203.0.113.9');
    expectError(limited, 429, 'RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expectError(await t.anon.post(`/api/v1/public/onboarding/${UNKNOWN_TOKEN}`).set('X-Forwarded-For', '203.0.113.9').send(registrationPayload()), 429, 'RATE_LIMITED');
    expectError(await from('203.0.113.10'), 400, 'VALIDATION');
    // The GET page is not limited.
    expectError(await t.anon.get(`/api/v1/public/onboarding/${UNKNOWN_TOKEN}`).set('X-Forwarded-For', '203.0.113.9'), 404, 'NOT_FOUND');
    registrationRateLimit.reset();
    expectError(await from('203.0.113.9'), 400, 'VALIDATION');
  });
});

describe('review', () => {
  let gateway: string; // the ACO registration submitted above (40 % at DEL)
  let second: string; // another ACO at DEL
  let airportReg: string; // an AIRPORT registration at BOM

  beforeAll(async () => {
    gateway = idString((await RegistrationModel.findOne({ 'organisation.name': 'Gateway Cargo Services' }).lean())!._id);
    const two = await createLink({ orgType: 'ACO', airportId: del });
    second = (
      await t.anon.post(`/api/v1/public/onboarding/${two.token}`).send(
        registrationPayload({
          organisation: { ...(registrationPayload()['organisation'] as object), name: 'Second Cargo', legalName: undefined },
          admin: { name: 'Ravi Kumar', email: 'ravi@second.test', phone: '+91 2' },
          marketSharePct: 25,
        }),
      )
    ).body.data.registrationId;
    const three = await createLink({ orgType: 'AIRPORT', airportId: bom });
    airportReg = (
      await t.anon.post(`/api/v1/public/onboarding/${three.token}`).send(
        registrationPayload({
          organisation: { ...(registrationPayload()['organisation'] as object), name: 'Mumbai Airport Cargo Authority' },
          admin: { name: 'Priya Shah', email: 'priya@bomairport.test', phone: '+91 3' },
          marketSharePct: undefined,
        }),
      )
    ).body.data.registrationId;
  });

  it('lists registrations with filters and search', async () => {
    const all = await superAdmin.get('/api/v1/registrations');
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(3);
    expect((all.body.data as { id: string }[]).map((r) => r.id)).toEqual([airportReg, second, gateway]);
    expect(all.body.data[0]).toMatchObject({ orgType: 'AIRPORT', airport: { iata: 'BOM' }, status: 'SUBMITTED', marketSharePct: null });
    expect(all.body.data[0]).not.toHaveProperty('marketShare');
    expect((await superAdmin.get('/api/v1/registrations?status=SUBMITTED')).body.meta.total).toBe(3);
    expect((await superAdmin.get('/api/v1/registrations?status=APPROVED')).body.meta.total).toBe(0);
    expect((await superAdmin.get('/api/v1/registrations?orgType=AIRPORT')).body.meta.total).toBe(1);
    expect((await superAdmin.get(`/api/v1/registrations?airportId=${del}`)).body.meta.total).toBe(2);
    expect((await superAdmin.get('/api/v1/registrations?q=ravi@second')).body.data[0].id).toBe(second);
    expectError(await superAdmin.get('/api/v1/registrations?status=PENDING'), 400, 'VALIDATION');
  });

  it("shows the airport's current share set and the projected total on the detail; AIRPORT registrations carry none", async () => {
    const res = await superAdmin.get(`/api/v1/registrations/${gateway}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: gateway,
      status: 'SUBMITTED',
      marketSharePct: 40,
      organisation: { name: 'Gateway Cargo Services', address: { pincode: '110037' }, contact: { email: 'desk@gateway.test' } },
      marketShare: { total: 60, projectedTotal: 100, entries: [{ code: 'DEL-EXISTING', sharePct: 60 }] },
    });
    const over = await superAdmin.get(`/api/v1/registrations/${second}`);
    expect(over.body.data.marketShare).toMatchObject({ total: 60, projectedTotal: 85 });
    expect((await superAdmin.get(`/api/v1/registrations/${airportReg}`)).body.data.marketShare).toBeNull();
    expectError(await superAdmin.get('/api/v1/registrations/0123456789abcdef01234567'), 404, 'NOT_FOUND');
    expectError(await superAdmin.get('/api/v1/registrations/nope'), 400, 'VALIDATION');
  });

  it('an operator user cannot see registrations: 403 without the task, 403 by scope with it', async () => {
    const acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'REVIEW-ACO' });
    expectError(await acoAdmin.get('/api/v1/registrations'), 403, 'FORBIDDEN');
    await grantTasks('ACO_ADMIN', ['onboarding.review']);
    expectError(await acoAdmin.get('/api/v1/registrations'), 403, 'FORBIDDEN');
    expectError(await acoAdmin.get(`/api/v1/registrations/${gateway}`), 403, 'FORBIDDEN');
    expectError(await acoAdmin.post(`/api/v1/registrations/${gateway}/approve`).send({ code: 'HIJACK' }), 403, 'FORBIDDEN');
    expectError(await acoAdmin.post(`/api/v1/registrations/${gateway}/reject`).send({ note: 'no' }), 403, 'FORBIDDEN');
    expect((await RegistrationModel.findById(gateway).lean())?.status).toBe('SUBMITTED');
  });

  it('approve creates the ACTIVE organisation (via LINK), the INVITED admin, the ACO_ADMIN membership and the share; e-mails; audits', async () => {
    const res = await superAdmin.post(`/api/v1/registrations/${gateway}/approve`).send({ code: 'del-gateway', note: 'Welcome aboard' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      id: gateway,
      status: 'APPROVED',
      reviewedBy: idString(superAdmin.user._id),
      reviewNote: 'Welcome aboard',
      marketSharePct: 40,
      marketShare: { total: 100, projectedTotal: 100 },
    });
    expect(res.body.data.reviewedAt).toBeTruthy();
    const orgId = res.body.data.resultOrgId as string;

    const org = await findOrganisationByCode('DEL-GATEWAY');
    expect(org).toMatchObject({
      type: 'ACO',
      name: 'Gateway Cargo Services',
      legalName: 'Gateway Cargo Services Pvt Ltd',
      status: 'ACTIVE',
      createdVia: 'LINK',
      operations: { domestic: true, international: false },
      address: { line1: 'Cargo Complex, Gate 4', pincode: '110037' },
      contact: { email: 'desk@gateway.test' },
    });
    expect(idString(org!._id)).toBe(orgId);
    expect(idString(org!.airportId!)).toBe(del);
    expect(idString(org!.approvedBy!)).toBe(idString(superAdmin.user._id));
    expect(org!.approvedAt).toBeInstanceOf(Date);

    const admin = await UserModel.findOne({ email: 'meera.nair@gateway.test' }).lean();
    expect(admin).toMatchObject({ name: 'Meera Nair', phone: '+91 98111 11111', status: 'INVITED', keycloakSub: null });
    const membership = await MembershipModel.findOne({ userId: admin!._id, orgId: org!._id }).lean();
    expect(membership?.status).toBe('ACTIVE');
    const operator = await superAdmin.get(`/api/v1/operators/${orgId}`);
    expect(operator.body.data).toMatchObject({ code: 'DEL-GATEWAY', createdVia: 'LINK', memberCount: 1, currentShare: 40 });
    const shares = await superAdmin.get(`/api/v1/airports/${del}/market-share`);
    expect(shares.body.data.total).toBe(100);
    expect((shares.body.data.entries as { code: string; sharePct: number }[]).map((e) => [e.code, e.sharePct])).toEqual([['DEL-EXISTING', 60], ['DEL-GATEWAY', 40]]);

    const mail = await NotificationModel.findOne({ to: 'meera.nair@gateway.test', template: 'registration-approved' }).lean();
    expect(mail?.status).toBe('SENT');
    expect(mail?.body).toContain('(code DEL-GATEWAY)');
    expect(idString(mail!.refs.acoId!)).toBe(orgId);
    expect(idString(mail!.refs.userId!)).toBe(idString(admin!._id));

    const audit = await AuditModel.findOne({ action: 'registration.approved', entityId: gateway }).lean();
    expect(idString(audit!.orgId!)).toBe(orgId);
    expect(idString(audit!.actorUserId!)).toBe(idString(superAdmin.user._id));
    expect(audit?.after).toMatchObject({ status: 'APPROVED', organisation: { code: 'DEL-GATEWAY' }, admin: { email: 'meera.nair@gateway.test', roleCode: 'ACO_ADMIN' }, marketSharePct: 40 });
    expect((await superAdmin.get('/api/v1/registrations?status=APPROVED')).body.meta.total).toBe(1);
  });

  it('a reviewed registration cannot be approved or rejected again (409); nothing is created twice', async () => {
    expectError(await superAdmin.post(`/api/v1/registrations/${gateway}/approve`).send({ code: 'DEL-GATEWAY-2' }), 409, 'CONFLICT');
    expectError(await superAdmin.post(`/api/v1/registrations/${gateway}/reject`).send({ note: 'changed my mind' }), 409, 'CONFLICT');
    expect(await findOrganisationByCode('DEL-GATEWAY-2')).toBeNull();
    expect(await MembershipModel.countDocuments({ userId: (await UserModel.findOne({ email: 'meera.nair@gateway.test' }).lean())!._id })).toBe(1);
    expect(await AuditModel.countDocuments({ action: 'registration.approved', entityId: gateway })).toBe(1);
  });

  it('approve validates: duplicate organisation code is 409, unknown registration 404, bad body 400', async () => {
    expectError(await superAdmin.post(`/api/v1/registrations/${second}/approve`).send({ code: 'DEL-GATEWAY' }), 409, 'CONFLICT');
    expectError(await superAdmin.post(`/api/v1/registrations/${second}/approve`).send({ code: 'DEL-EXISTING' }), 409, 'CONFLICT');
    expectError(await superAdmin.post('/api/v1/registrations/0123456789abcdef01234567/approve').send({ code: 'X-1' }), 404, 'NOT_FOUND');
    expectError(await superAdmin.post(`/api/v1/registrations/${second}/approve`).send({}), 400, 'VALIDATION');
    expectError(await superAdmin.post(`/api/v1/registrations/${second}/approve`).send({ code: 'a' }), 400, 'VALIDATION');
    expectError(await superAdmin.post(`/api/v1/registrations/${second}/approve`).send({ code: 'DEL-SECOND', marketSharePct: 101 }), 400, 'VALIDATION');
    expect((await RegistrationModel.findById(second).lean())?.status).toBe('SUBMITTED');
    expect(await findOrganisationByCode('DEL-SECOND')).toBeNull();
  });

  it('reject records the note, e-mails the applicant and audits; the note is mandatory', async () => {
    expectError(await superAdmin.post(`/api/v1/registrations/${second}/reject`).send({}), 400, 'VALIDATION');
    expectError(await superAdmin.post(`/api/v1/registrations/${second}/reject`).send({ note: '   ' }), 400, 'VALIDATION');
    const res = await superAdmin.post(`/api/v1/registrations/${second}/reject`).send({ note: 'Shares at DEL are fully allocated' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: second,
      status: 'REJECTED',
      reviewNote: 'Shares at DEL are fully allocated',
      reviewedBy: idString(superAdmin.user._id),
      resultOrgId: null,
      marketShare: { total: 100, projectedTotal: 100 },
    });
    const mail = await NotificationModel.findOne({ to: 'ravi@second.test', template: 'registration-rejected' }).lean();
    expect(mail?.status).toBe('SENT');
    expect(mail?.subject).toBe('Registration for Second Cargo was not approved');
    expect(mail?.body).toContain('Reason: Shares at DEL are fully allocated');
    const audit = await AuditModel.findOne({ action: 'registration.rejected', entityId: second }).lean();
    expect(audit?.after).toEqual({ status: 'REJECTED', note: 'Shares at DEL are fully allocated' });
    expectError(await superAdmin.post(`/api/v1/registrations/${second}/reject`).send({ note: 'again' }), 409, 'CONFLICT');
    expectError(await superAdmin.post(`/api/v1/registrations/${second}/approve`).send({ code: 'DEL-SECOND' }), 409, 'CONFLICT');
    expect(await UserModel.countDocuments({ email: 'ravi@second.test' })).toBe(0);
  });

  it('approves an AIRPORT registration with an AIRPORT_ADMIN membership and no share; a share in the body is refused', async () => {
    expectError(await superAdmin.post(`/api/v1/registrations/${airportReg}/approve`).send({ code: 'BOM-AIRPORT', marketSharePct: 10 }), 400, 'VALIDATION');
    const res = await superAdmin.post(`/api/v1/registrations/${airportReg}/approve`).send({ code: 'BOM-AIRPORT' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', marketShare: null, reviewNote: null });
    const org = await findOrganisationByCode('BOM-AIRPORT');
    expect(org).toMatchObject({ type: 'AIRPORT', status: 'ACTIVE', createdVia: 'LINK', name: 'Mumbai Airport Cargo Authority' });
    expect(idString(org!.airportId!)).toBe(bom);
    const admin = await UserModel.findOne({ email: 'priya@bomairport.test' }).lean();
    expect(admin?.status).toBe('INVITED');
    const [membership] = await MembershipModel.find({ userId: admin!._id }).lean();
    expect(idString(membership!.orgId)).toBe(idString(org!._id));
    const roles = await superAdmin.get(`/api/v1/users?orgId=${idString(org!._id)}`);
    expect(roles.body.data[0].memberships[0].roleCode).toBe('AIRPORT_ADMIN');
    expect((await superAdmin.get(`/api/v1/airports/${bom}/market-share`)).body.data.entries).toEqual([]);
    expect(await NotificationModel.countDocuments({ to: 'priya@bomairport.test', template: 'registration-approved' })).toBe(1);
  });
});
