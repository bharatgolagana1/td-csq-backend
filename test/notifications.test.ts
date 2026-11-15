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
    // Modules register their own templates, so the registry holds at least the
    // foundation's four; exact membership is each module's own test's business.
    expect(TEMPLATE_NAMES).toEqual(expect.arrayContaining(['account-invited', 'generic', 'registration-approved', 'registration-received']));
    expect(new Set(TEMPLATE_NAMES).size).toBe(TEMPLATE_NAMES.length);
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

  it('name the survey in every participant e-mail, so a customer in both surveys of a cycle can tell them apart', () => {
    const common = { brandName: 'ACFI', webUrl: 'https://csq.test' };
    const facts = { contactName: 'Meera', customerName: 'Fast Freight', operatorName: 'Delhi Cargo', airportName: 'Delhi (DEL)', cycleName: 'CSQ 2026 H2', assessmentStart: '1 Nov 2026', assessmentEnd: '30 November 2026, 23:59 IST', url: 'https://csq.test/assess/t' };
    const invitation = (surveyType: string) => renderTemplate('assessment-invitation', { ...facts, surveyType }, common);
    expect(invitation('Domestic').subject).toBe('CSQ 2026 H2 · Domestic survey: please rate Delhi Cargo');
    expect(invitation('International').subject).toBe('CSQ 2026 H2 · International survey: please rate Delhi Cargo');
    expect(invitation('International').text).toContain('assess the international cargo services of Delhi Cargo at Delhi (DEL)');

    const reminder = renderTemplate('assessment-reminder', { ...facts, surveyType: 'International', reminderNumber: 2 }, common);
    expect(reminder.subject).toBe('CSQ 2026 H2 · International survey: reminder to rate Delhi Cargo by 30 November 2026, 23:59 IST');
    expect(reminder.text).toContain('your assessment of the international cargo services of Delhi Cargo for the ACFI survey "CSQ 2026 H2" is still open');

    const thanks = renderTemplate('assessment-thank-you', { contactName: 'Meera', operatorName: 'Delhi Cargo', cycleName: 'CSQ 2026 H2', surveyType: 'Domestic' }, common);
    expect(thanks.subject).toBe('CSQ 2026 H2 · Domestic survey: thank you for rating Delhi Cargo');
    expect(thanks.text).toContain('the domestic cargo services of Delhi Cargo');

    const otp = renderTemplate('assessment-otp', { contactName: 'Meera', operatorName: 'Delhi Cargo', surveyType: 'Domestic', otp: '123456', expiresInMinutes: 10 }, common);
    expect(otp.subject).toBe('123456 is your ACFI CSQ code · Domestic survey');
    expect(otp.text).toContain('open your assessment of the domestic cargo services of Delhi Cargo');
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

  it('e-mailed links and one-time codes are masked in the outbox; with the LOG transport they show', async () => {
    const base = { refs: { cycleId: null, acoId: null, customerId: null, invitationId: null, userId: null }, status: 'SENT', html: '' };
    const url = `${t.env.PUBLIC_WEB_URL}/assess/Tok3n-Secret_x`;
    await NotificationModel.create([
      { ...base, channel: 'EMAIL', template: 'assessment-otp', to: 'otp@test.csq', subject: '483920 is your ACFI CSQ code', body: 'Your code: 483920\n', vars: { otp: '483920', contactName: 'C' } },
      { ...base, channel: 'EMAIL', template: 'assessment-invitation', to: 'inv@test.csq', subject: 'Your CSQ assessment', body: `Start the assessment: ${url}\n`, vars: { url } },
      { ...base, channel: 'LOG', template: 'assessment-invitation', to: 'log@test.csq', subject: 'Your CSQ assessment', body: `Start the assessment: ${url}\n`, vars: { url } },
    ]);
    const rows = (await superAdmin.get('/api/v1/notifications?q=test.csq&pageSize=100')).body.data as { to: string; subject: string; body: string; vars: Record<string, unknown> }[];
    const byTo = (to: string) => rows.find((row) => row.to === to)!;
    expect(byTo('otp@test.csq')).toMatchObject({ subject: '•••••• is your ACFI CSQ code', body: 'Your code: ••••••\n', vars: { otp: '••••••' } });
    expect(byTo('inv@test.csq').body).toBe(`Start the assessment: ${t.env.PUBLIC_WEB_URL}/assess/••••••\n`);
    expect(byTo('inv@test.csq').vars['url']).toBe(`${t.env.PUBLIC_WEB_URL}/assess/••••••`);
    expect(JSON.stringify([byTo('otp@test.csq'), byTo('inv@test.csq')])).not.toMatch(/483920|Tok3n-Secret_x/);
    expect(byTo('log@test.csq').body).toContain('/assess/Tok3n-Secret_x');
    await NotificationModel.deleteMany({ to: { $in: ['otp@test.csq', 'inv@test.csq', 'log@test.csq'] } });
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
