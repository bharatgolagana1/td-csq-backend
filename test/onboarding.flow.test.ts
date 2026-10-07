// The onboarding flow end to end (ARCHITECTURE §7): ACFI mints a link → the
// applicant reads and submits the form → ACFI reviews with the airport's share
// total in view → approval creates the operator → its admin signs in for the
// first time and lands in the ACO scope, where registrations are off limits.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import { registrationRateLimit } from '../src/modules/onboarding/onboarding.ratelimit.js';

import { createTestApp, tokenFor, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, expectError } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let hyd: string;

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  hyd = await airportIdByIata('HYD');
  registrationRateLimit.reset();
});
afterAll(() => t.close());

describe('link → form → review → approve → first sign-in', () => {
  let token: string;
  let registrationId: string;
  let acoId: string;

  it('ACFI mints a link for an operator at HYD', async () => {
    const res = await superAdmin.post('/api/v1/onboarding/links').send({ orgType: 'ACO', airportId: hyd, expiresInDays: 7, note: 'Deccan Cargo' });
    expect(res.status).toBe(201);
    token = (res.body.data.url as string).split('/register/')[1]!;
  });

  it('the applicant opens the form and submits it', async () => {
    const page = await t.anon.get(`/api/v1/public/onboarding/${token}`);
    expect(page.body.data).toMatchObject({ orgType: 'ACO', airport: { iata: 'HYD' }, used: false });

    const res = await t.anon.post(`/api/v1/public/onboarding/${token}`).send({
      organisation: {
        name: 'Deccan Cargo Handlers',
        address: { line1: 'Air Cargo Complex', city: 'Hyderabad', state: 'Telangana', pincode: '500409' },
        contact: { name: 'Shift Desk', email: 'desk@deccan.test', phone: '+91 40 1234 5678' },
      },
      admin: { name: 'Arjun Reddy', email: 'arjun@deccan.test', phone: '+91 90000 00000' },
      operations: { domestic: true, international: true },
      marketSharePct: 100,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    registrationId = res.body.data.registrationId;
    expect((await t.anon.get(`/api/v1/public/onboarding/${token}`)).body.data.used).toBe(true);
    expect(await NotificationModel.countDocuments({ to: 'arjun@deccan.test', template: 'registration-received' })).toBe(1);
    expect(await NotificationModel.countDocuments({ to: superAdmin.user.email, template: 'generic' })).toBe(1);
  });

  it('ACFI sees the request with the airport share total (nothing allocated yet) and approves it', async () => {
    const pending = await superAdmin.get('/api/v1/registrations?status=SUBMITTED');
    expect((pending.body.data as { id: string }[]).map((r) => r.id)).toEqual([registrationId]);
    const detail = await superAdmin.get(`/api/v1/registrations/${registrationId}`);
    expect(detail.body.data.marketShare).toEqual({ entries: [], total: 0, projectedTotal: 100 });

    const approved = await superAdmin.post(`/api/v1/registrations/${registrationId}/approve`).send({ code: 'HYD-DECCAN' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', marketShare: { total: 100, projectedTotal: 100 } });
    acoId = approved.body.data.resultOrgId;

    const operators = await superAdmin.get(`/api/v1/operators?airportId=${hyd}`);
    expect(operators.body.data).toHaveLength(1);
    expect(operators.body.data[0]).toMatchObject({ id: acoId, code: 'HYD-DECCAN', status: 'ACTIVE', createdVia: 'LINK', memberCount: 1, currentShare: 100 });
  });

  it('the new admin signs in for the first time, is linked by e-mail and lands in the ACO scope', async () => {
    const bearer = `Bearer ${tokenFor({ sub: 'kc-arjun', email: 'ARJUN@deccan.test', name: 'Arjun Reddy', email_verified: true })}`;
    const me = await t.anon.get('/api/v1/me').set('Authorization', bearer);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.data.user).toMatchObject({ email: 'arjun@deccan.test', name: 'Arjun Reddy', status: 'ACTIVE' });
    expect(me.body.data.memberships).toEqual([expect.objectContaining({ orgId: acoId, orgCode: 'HYD-DECCAN', orgType: 'ACO', roleCode: 'ACO_ADMIN', airportId: hyd })]);
    expect(me.body.data.active).toMatchObject({ orgId: acoId, roleCode: 'ACO_ADMIN', scope: { kind: 'ACO', acoId } });
    expect(me.body.data.active.tasks).toContain('users.manage');

    // Registrations are platform business: the operator admin is refused and the token cannot reach the links either.
    expectError(await t.anon.get('/api/v1/registrations').set('Authorization', bearer), 403, 'FORBIDDEN');
    expectError(await t.anon.get('/api/v1/onboarding/links').set('Authorization', bearer), 403, 'FORBIDDEN');
    // The operator sees itself through the operators API once granted the view task elsewhere; here it simply exists.
    expect((await superAdmin.get(`/api/v1/operators/${acoId}`)).body.data.contact.email).toBe('desk@deccan.test');
    expect(idString(superAdmin.org._id)).not.toBe(acoId);
  });
});
