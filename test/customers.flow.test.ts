// The customers part of the flow: an operator fills the downloaded template,
// validates, commits, and the directory is what sampling will draw from.
import Papa from 'papaparse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { countByAco, listEligible } from '../src/modules/customers/customers.service.js';
import { CUSTOMER_CSV_HEADERS } from '../src/modules/customers/domain/csvTemplate.js';
import { participantSurveyTypes } from '../src/modules/cycles/domain/participants.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';

let t: TestApp;
let superAdmin: TestUser;
let acoAdmin: TestUser;
let acoId: string;

const CUSTOMERS = '/api/v1/customers';

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'FLOW-ACO', airportIata: 'BLR' });
  acoId = idString(acoAdmin.org._id);
});
afterAll(() => t.close());

describe('template → validate → commit → eligible', () => {
  it('builds the directory from the template and exposes it to sampling', async () => {
    // 1. Download the template and keep only its header.
    const template = await acoAdmin.get(`${CUSTOMERS}/import/template`);
    expect(template.status).toBe(200);
    const header = template.text.split('\r\n')[0];
    expect(header).toBe(CUSTOMER_CSV_HEADERS.join(','));

    // 2. Fill it the way an operator would (synonyms, loose phone formats, a blank contact).
    const filled = Papa.unparse({
      fields: [...CUSTOMER_CSV_HEADERS],
      data: [
        ['Blue Dart Express', 'Ravi Kumar', 'ravi@bluedart.test', '98450 00001', 'Freight Forwarder', 'Both', 'key-account'],
        ['Chennai Customs House', '', 'chq@cch.test', '+91 98450 00002', 'CHA', 'International', ''],
        ['Local Movers', 'Sunita', 'sunita@local.test', '0 98450 00003', 'FF', 'Domestic', 'small'],
      ],
    });
    const validated = await acoAdmin.post(`${CUSTOMERS}/import/validate`).attach('file', Buffer.from(filled), 'members.csv');
    expect(validated.status).toBe(201);
    expect(validated.body.data).toMatchObject({ rows: 3, accepted: 3, rejected: 0, errors: [] });
    expect((validated.body.data.preview as { action: string }[]).every((row) => row.action === 'CREATE')).toBe(true);

    // 3. Commit, then re-import one row with a change: it becomes an UPDATE, not a duplicate.
    const committed = await acoAdmin.post(`${CUSTOMERS}/import/${validated.body.data.importId}/commit`);
    expect(committed.body.data).toMatchObject({ status: 'COMMITTED', created: 3, updated: 0 });
    const again = await acoAdmin
      .post(`${CUSTOMERS}/import/validate`)
      .set('Content-Type', 'text/csv')
      .send(`${CUSTOMER_CSV_HEADERS.join(',')}\nBlue Dart Express,Ravi Kumar,RAVI@bluedart.test,9845000001,FF,DOMESTIC,key-account\n`);
    expect((again.body.data.preview as { action: string }[]).map((row) => row.action)).toEqual(['UPDATE']);
    const second = await acoAdmin.post(`${CUSTOMERS}/import/${again.body.data.importId}/commit`);
    expect(second.body.data).toMatchObject({ created: 0, updated: 1 });
    expect(await AuditModel.countDocuments({ action: 'customer.imported', orgId: acoAdmin.org._id })).toBe(2);

    // 4. What sampling sees: the operator runs both survey types, so a BOTH cycle offers one entry per type.
    const list = await acoAdmin.get(CUSTOMERS);
    expect((list.body.data as { name: string; surveyType: string; contactPerson: string }[]).map((c) => [c.name, c.surveyType, c.contactPerson])).toEqual([
      ['Blue Dart Express', 'DOMESTIC', 'Ravi Kumar'],
      ['Chennai Customs House', 'INTERNATIONAL', 'Chennai Customs House'],
      ['Local Movers', 'DOMESTIC', 'Sunita'],
    ]);
    const types = participantSurveyTypes('BOTH', acoAdmin.org.operations);
    expect(types).toEqual(['DOMESTIC', 'INTERNATIONAL']);
    const eligible = await listEligible(acoId, 'BOTH', types);
    expect(eligible.map((e) => `${e.customer.email}:${e.surveyType}`)).toEqual([
      'ravi@bluedart.test:DOMESTIC',
      'chq@cch.test:INTERNATIONAL',
      'sunita@local.test:DOMESTIC',
    ]);
    // A domestic-only participant never offers the international customer.
    expect((await listEligible(acoId, 'BOTH', ['DOMESTIC'])).map((e) => e.customer.email)).toEqual(['ravi@bluedart.test', 'sunita@local.test']);

    // 5. Deactivating one drops it from eligibility and from the operator card.
    const local = (list.body.data as { id: string; email: string }[]).find((c) => c.email === 'sunita@local.test');
    await acoAdmin.post(`${CUSTOMERS}/${local!.id}/deactivate`);
    expect((await listEligible(acoId, 'DOMESTIC')).map((e) => e.customer.email)).toEqual(['ravi@bluedart.test']);
    expect(await countByAco(acoId)).toBe(2);
    expect((await superAdmin.get(`/api/v1/operators/${acoId}`)).body.data.customerCount).toBe(2);
  });
});
