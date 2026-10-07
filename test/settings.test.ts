import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditModel } from '../src/modules/audit/audit.model.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { expectError } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;

beforeAll(async () => {
  t = await createTestApp({ airports: false });
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
});
afterAll(() => t.close());

describe('/settings', () => {
  it('returns the §5 defaults', async () => {
    const res = await superAdmin.get('/api/v1/settings');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      scoring: { minResponses: 3, weightingMode: 'EQUAL' },
      defaults: {
        samplingDays: 10,
        assessmentDays: 30,
        reminders: { sampling: { count: 3, everyDays: 3 }, assessment: { count: 10, everyDays: 2 } },
        tz: 'Asia/Kolkata',
      },
      branding: { orgName: 'Air Cargo Forum India' },
      revealAssessorIdentity: false,
    });
    expect(typeof res.body.data.rbacVersion).toBe('number');
  });

  it('merges a nested partial patch and audits it', async () => {
    const res = await superAdmin.patch('/api/v1/settings').send({ scoring: { minResponses: 5 }, defaults: { reminders: { sampling: { count: 2, everyDays: 4 } } } });
    expect(res.status).toBe(200);
    expect(res.body.data.scoring).toEqual({ minResponses: 5, weightingMode: 'EQUAL' });
    expect(res.body.data.defaults.reminders).toEqual({ sampling: { count: 2, everyDays: 4 }, assessment: { count: 10, everyDays: 2 } });
    expect(res.body.data.defaults.samplingDays).toBe(10);
    const audit = await AuditModel.findOne({ action: 'settings.updated' }).lean();
    expect((audit?.before as { scoring: { minResponses: number } }).scoring.minResponses).toBe(3);
    expect((audit?.after as { scoring: { minResponses: number } }).scoring.minResponses).toBe(5);
  });

  it('rejects system-managed and unknown fields', async () => {
    expectError(await superAdmin.patch('/api/v1/settings').send({ rbacVersion: 99 }), 400, 'VALIDATION');
    expectError(await superAdmin.patch('/api/v1/settings').send({ scoring: { weightingMode: 'RANDOM' } }), 400, 'VALIDATION');
    const noop = await superAdmin.patch('/api/v1/settings').send({});
    expect(noop.status).toBe(200);
  });

  it('settings.view without settings.manage can read but not write', async () => {
    const analyst = await t.asUser({ orgType: 'ACFI', roleCode: 'ACFI_ANALYST' });
    expect((await analyst.get('/api/v1/settings')).status).toBe(200);
    expectError(await analyst.patch('/api/v1/settings').send({ branding: { orgName: 'X' } }), 403, 'FORBIDDEN');
  });
});
