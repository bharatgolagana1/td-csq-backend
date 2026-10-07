import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import { configureNotifications, send } from '../src/modules/notifications/notifications.service.js';
import { createLogTransport } from '../src/modules/notifications/notifications.transport.js';
import { renderTemplate, TEMPLATE_NAMES } from '../src/modules/notifications/templates/index.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { createTestOperator, expectError, grantTasks } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let acoId: string;

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  acoId = idString((await createTestOperator({ code: 'NOTIF-ACO' }))._id);
});
afterAll(() => t.close());

describe('templates', () => {
  it('render subject, text and escaped HTML for every template', () => {
    expect(TEMPLATE_NAMES.sort()).toEqual(['account-invited', 'generic', 'registration-approved', 'registration-received']);
    const common = { brandName: 'ACFI', webUrl: 'https://csq.test' };
    const invited = renderTemplate('account-invited', { name: 'A <b>', orgName: 'Org & Co', roleName: 'Role', invitedBy: 'Admin' }, common);
    expect(invited.subject).toBe('You have been invited to ACFI CSQ');
    expect(invited.text).toContain('Dear A <b>,');
    expect(invited.html).toContain('A &lt;b&gt;');
    expect(invited.html).toContain('Org &amp; Co');
    expect(invited.html).toContain('href="https://csq.test"');
    const generic = renderTemplate('generic', { subject: 'Hi', paragraphs: ['One', 'Two'], linkUrl: 'https://x.test', linkLabel: 'Open' }, common);
    expect(generic.text).toBe('One\n\nTwo\n\nOpen: https://x.test\n');
    expect(renderTemplate('registration-received', { adminName: 'A', orgName: 'O', airportName: 'DEL' }, common).subject).toContain('Registration received');
    expect(renderTemplate('registration-approved', { adminName: 'A', orgName: 'O', orgCode: 'O1' }, common).text).toContain('(code O1)');
  });
});

describe('send()', () => {
  it('writes a SENT row through the LOG transport with rendered content and refs', async () => {
    const dto = await send({
      template: 'generic',
      to: 'Someone@Test.csq',
      vars: { subject: 'Hello', paragraphs: ['Body'] },
      refs: { acoId, cycleId: null },
    });
    expect(dto).toMatchObject({ channel: 'LOG', template: 'generic', to: 'someone@test.csq', subject: 'Hello', status: 'SENT', error: null, resendOf: null });
    expect(dto.sentAt).toBeTruthy();
    expect(dto.refs).toEqual({ cycleId: null, acoId, customerId: null, invitationId: null, userId: null });
    const row = await NotificationModel.findById(dto.id).lean();
    expect(row?.html).toContain('<p>Body</p>');
  });

  it('records a FAILED row when the transport throws, without throwing itself', async () => {
    configureNotifications({
      transport: { channel: 'EMAIL', deliver: async () => { throw new Error('SMTP down'); } },
      from: t.env.MAIL_FROM,
      webUrl: t.env.PUBLIC_WEB_URL,
      brandName: 'ACFI',
    });
    try {
      const dto = await send({ template: 'generic', to: 'fail@test.csq', vars: { subject: 'Fail', paragraphs: [] } });
      expect(dto).toMatchObject({ channel: 'EMAIL', status: 'FAILED', error: 'SMTP down', sentAt: null });
    } finally {
      configureNotifications({ transport: createLogTransport(), from: t.env.MAIL_FROM, webUrl: t.env.PUBLIC_WEB_URL, brandName: 'ACFI' });
    }
  });
});

describe('GET /notifications and resend', () => {
  it('lists with filters for the platform', async () => {
    const all = await superAdmin.get('/api/v1/notifications');
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBeGreaterThanOrEqual(2);
    const failed = await superAdmin.get('/api/v1/notifications?status=FAILED');
    expect((failed.body.data as { to: string }[]).map((n) => n.to)).toEqual(['fail@test.csq']);
    const byAco = await superAdmin.get(`/api/v1/notifications?acoId=${acoId}&template=generic`);
    expect((byAco.body.data as { to: string }[]).map((n) => n.to)).toEqual(['someone@test.csq']);
    expect((await superAdmin.get('/api/v1/notifications?q=someone')).body.meta.total).toBe(1);
  });

  it('an operator sees only notifications linked to it and can resend them', async () => {
    await grantTasks('ACO_ADMIN', ['notifications.view', 'notifications.send']);
    const acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: acoId });
    const list = await acoAdmin.get('/api/v1/notifications');
    expect(list.status).toBe(200);
    const rows = list.body.data as { id: string; to: string }[];
    // The admin's own invitation (asUser does not send one) is absent; only the generic mail linked to the ACO is visible.
    expect(rows.map((n) => n.to)).toEqual(['someone@test.csq']);

    const resent = await acoAdmin.post(`/api/v1/notifications/${rows[0]!.id}/resend`);
    expect(resent.status).toBe(201);
    expect(resent.body.data).toMatchObject({ to: 'someone@test.csq', status: 'SENT', resendOf: rows[0]!.id, template: 'generic' });
    const audit = await AuditModel.findOne({ action: 'notification.resent' }).lean();
    expect(audit?.entityId).toBe(resent.body.data.id);
    expect(idString(audit!.orgId!)).toBe(acoId);

    const failedId = (await NotificationModel.findOne({ to: 'fail@test.csq' }).lean())!._id.toHexString();
    expectError(await acoAdmin.post(`/api/v1/notifications/${failedId}/resend`), 404, 'NOT_FOUND');
    expect((await superAdmin.post(`/api/v1/notifications/${failedId}/resend`)).status).toBe(201);
    expectError(await superAdmin.post('/api/v1/notifications/0123456789abcdef01234567/resend'), 404, 'NOT_FOUND');
  });
});
