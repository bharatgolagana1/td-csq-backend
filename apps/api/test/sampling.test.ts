import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { newId } from '../src/kernel/ids.js';
import { checkModule } from '../src/kernel/router.js';
import { listAudit } from '../src/modules/sampling/sampling.audit.js';
import {
  createContact,
  deactivateContact,
  exportContactsCsv,
  listContacts,
  readContact,
  updateContact,
} from '../src/modules/sampling/sampling.contacts.js';
import { commitImport, validateImport } from '../src/modules/sampling/sampling.import.js';
import { readIntegrity } from '../src/modules/sampling/sampling.integrity.js';
import {
  approveBatch,
  createBatch,
  diffBatch,
  listBatches,
  lockBatch,
  previewGate,
  readBatch,
  rejectBatch,
  reviewAdd,
  reviewCorrect,
  reviewRemove,
  setSelection,
} from '../src/modules/sampling/sampling.batches.js';
import {
  patchSamplingSettings,
  putCyclePolicy,
  readCyclePolicy,
  readSamplingSettings,
} from '../src/modules/sampling/sampling.policy.js';
import { SamplingAuditModel } from '../src/modules/sampling/sampling.models.js';
import { samplingModule } from '../src/modules/sampling/sampling.module.js';
import { closeDatabase, openDatabase } from './mongo.js';
import {
  asOrg,
  boundary,
  clearSampling,
  openCyclePolicy,
  samplingApp,
  samplingPrincipal,
  syncSamplingIndexes,
  TZ,
} from './sampling.fixtures.js';

/**
 * One file, because vitest gives each test file its own copy of the source
 * modules while mongoose keeps a single model registry for the worker. Split
 * across files, the second file's request context would be a different
 * AsyncLocalStorage from the one the already registered tenancy hooks read.
 */

const ORG_A = newId();
const ORG_B = newId();
const CYCLE = newId();
const operator = samplingPrincipal('operator', ORG_A);
const reviewer = samplingPrincipal('reviewer', ORG_A);
const stranger = samplingPrincipal('stranger', ORG_B);

const inA = <T>(fn: () => T): T => asOrg(operator, ORG_A, fn);
const asReviewer = <T>(fn: () => T): T => asOrg(reviewer, ORG_A, fn);
const inB = <T>(fn: () => T): T => asOrg(stranger, ORG_B, fn);

const DAY = 24 * 60 * 60 * 1000;
const HEADER = 'name,company,email,phone,customerType,formScope';

function contact(overrides: Partial<Parameters<typeof createContact>[0]> = {}) {
  return {
    name: 'Anita Rao',
    company: 'Blue Dart Express',
    email: 'anita@bluedart.co.in',
    phone: null,
    customerType: 'FREIGHT_FORWARDER' as const,
    formScope: 'INTERNATIONAL' as const,
    ...overrides,
  };
}

async function addContacts(
  count: number,
  overrides: { domain?: string; phone?: string | null; formScope?: 'INTERNATIONAL' | 'DOMESTIC'; prefix?: string } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const created = await inA(() =>
      createContact({
        name: `Contact ${index}`,
        company: `Forwarder ${overrides.prefix ?? ''}${index}`,
        email: `${overrides.prefix ?? 'c'}${index}@${overrides.domain ?? 'forwarder.in'}`,
        phone: overrides.phone ?? null,
        customerType: 'FREIGHT_FORWARDER',
        formScope: overrides.formScope ?? 'INTERNATIONAL',
      }),
    );
    ids.push(created.id);
  }
  return ids;
}

async function openCycle(minimum: number, now = new Date()): Promise<void> {
  await inA(() => putCyclePolicy(CYCLE, openCyclePolicy(now, minimum)));
}

async function draftBatch(): Promise<string> {
  const batch = await inA(() => createBatch({ cycleId: CYCLE, formScope: 'INTERNATIONAL', label: null }, new Date()));
  return batch.id;
}

beforeAll(async () => {
  await openDatabase();
  await syncSamplingIndexes();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearSampling();
});

describe('customer directory', () => {

  it('stores a contact and folds the address for deduplication', async () => {
    const created = await inA(() => createContact(contact({ email: 'Anita@BlueDart.CO.in' })));

    expect(created.email).toBe('Anita@BlueDart.CO.in');
    expect(created.status).toBe('ACTIVE');
    expect(created.source).toBe('MANUAL');
    expect((await inA(() => readContact(created.id))).company).toBe('Blue Dart Express');
  });

  it('refuses a second contact with the same address, whatever the casing', async () => {
    await inA(() => createContact(contact()));
    await expect(inA(() => createContact(contact({ email: 'ANITA@bluedart.co.in' })))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('lets the same address exist in another organisation, because it is the same forwarder', async () => {
    await inA(() => createContact(contact()));
    const theirs = await inB(() => createContact(contact()));

    expect(theirs.email).toBe('anita@bluedart.co.in');
    expect((await inB(() => listContacts({ limit: 50 }))).contacts).toHaveLength(1);
  });

  it('answers a read of another organisation contact as if it never existed', async () => {
    const mine = await inA(() => createContact(contact()));
    await expect(inB(() => readContact(mine.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a phone it cannot reach, and accepts a national number once a dialling code is set', async () => {
    await expect(inA(() => createContact(contact({ phone: '09812345678' })))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    await inA(() => patchSamplingSettings({ defaultDialCode: '+91' }));
    const created = await inA(() => createContact(contact({ phone: '098123 45678' })));
    expect(created.phoneE164).toBe('+919812345678');
  });

  it('deactivates rather than deletes, because a locked batch names the row', async () => {
    const created = await inA(() => createContact(contact()));
    const off = await inA(() => deactivateContact(created.id));

    expect(off.status).toBe('INACTIVE');
    expect(await inA(() => readContact(created.id))).toMatchObject({ status: 'INACTIVE' });
  });

  it('treats a search box as text, never as a pattern', async () => {
    await inA(() => createContact(contact({ company: 'Blue Dart Express' })));
    const hit = await inA(() => listContacts({ limit: 50, search: 'blue dart' }));
    const miss = await inA(() => listContacts({ limit: 50, search: '.*' }));

    expect(hit.contacts).toHaveLength(1);
    expect(miss.contacts).toHaveLength(0);
  });

  it('pages on the contact id', async () => {
    for (let index = 0; index < 5; index += 1) {
      await inA(() => createContact(contact({ email: `c${index}@bluedart.co.in` })));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await inA(() => listContacts({ limit: 2, cursor }));
      seen.push(...result.contacts.map((row) => row.id));
      cursor = result.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }

    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeUndefined();
  });

  it('neutralises a formula on the way out of the export', async () => {
    await inA(() => createContact(contact({ company: '=HYPERLINK("http://evil","click")' })));
    const csv = await inA(() => exportContactsCsv({}));

    expect(csv.split('\r\n')[0]).toBe('name,company,email,phone,customerType,formScope,status');
    expect(csv).toContain('"\'=HYPERLINK');
  });

  it('writes an audit entry for every mutation, with the actor', async () => {
    const created = await inA(() => createContact(contact()));
    await inA(() => updateContact(created.id, { company: 'Blue Dart Aviation' }));
    await inA(() => deactivateContact(created.id));

    const { entries } = await inA(() => listAudit({ limit: 50 }));
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'CONTACT_CREATED',
      'CONTACT_STATUS_CHANGED',
      'CONTACT_UPDATED',
    ]);
    expect(entries.every((entry) => entry.actorUserId === 'operator')).toBe(true);
    expect(entries.every((entry) => entry.subjectId === created.id)).toBe(true);
  });

  it('refuses to let the audit trail be rewritten', async () => {
    await inA(() => createContact(contact()));
    await expect(
      inA(() => SamplingAuditModel.updateOne({}, { $set: { actorName: 'someone else' } }).exec()),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('routes the export ahead of the contact id, and refuses a capability the caller lacks', async () => {
    const reader = samplingPrincipal('reader', ORG_A, ['sampling:read']);
    const app = samplingApp(reader, ORG_A);

    const exported = await request(app).get('/v1/sampling/contacts/export');
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');

    const denied = await request(app)
      .post('/v1/sampling/contacts')
      .send(contact());
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('answers an unparseable contact id with a validation failure, not a lookup', async () => {
    const app = samplingApp(operator, ORG_A);
    const response = await request(app).get('/v1/sampling/contacts/not-a-ulid');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});

describe('two phase contact import', () => {

  it('reports every row before anything is written', async () => {
    const csv = [
      HEADER,
      'Anita Rao,Blue Dart,anita@bluedart.co.in,,FREIGHT_FORWARDER,INTERNATIONAL',
      'Ravi Menon,Gati,not-an-address,,CUSTOMS_BROKER,INTERNATIONAL',
      'Sunil,,sunil@gati.in,,CUSTOMS_BROKER,DOMESTIC',
      'Anita Rao,Blue Dart,ANITA@bluedart.co.in,,FREIGHT_FORWARDER,INTERNATIONAL',
      'Meera,Allcargo,meera@allcargo.in,,FORWARDER,INTERNATIONAL',
    ].join('\r\n');

    const report = await inA(() => validateImport({ mode: 'UPSERT', fileName: 'x.csv', csv }));

    expect(report.state).toBe('VALIDATED');
    expect(report.counts).toMatchObject({ total: 5, create: 1, reject: 4 });
    expect(report.rows.map((row) => row.line)).toEqual([2, 3, 4, 5, 6]);
    expect(report.rows[1]?.problems[0]).toMatchObject({ column: 'email', code: 'INVALID_EMAIL' });
    expect(report.rows[2]?.problems[0]).toMatchObject({ column: 'company', code: 'MISSING_REQUIRED' });
    expect(report.rows[3]?.problems[0]).toMatchObject({ code: 'DUPLICATE_IN_FILE' });
    expect(report.rows[4]?.problems[0]).toMatchObject({ code: 'UNKNOWN_CUSTOMER_TYPE' });

    // nothing is written by the validate phase
    expect((await inA(() => listContacts({ limit: 50 }))).contacts).toHaveLength(0);
  });

  it('refuses a header it does not understand and never half reads the file', async () => {
    await expect(
      inA(() => validateImport({ mode: 'UPSERT', fileName: null, csv: 'name,company,mail\nA,B,c@d.in' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('sanitises a formula in a cell and says that it did', async () => {
    const csv = [
      HEADER,
      '"=cmd|\' /C calc\'!A0",Blue Dart,anita@bluedart.co.in,+919812345678,FREIGHT_FORWARDER,INTERNATIONAL',
    ].join('\r\n');

    const report = await inA(() => validateImport({ mode: 'UPSERT', fileName: null, csv }));
    expect(report.rows[0]?.sanitised).toBe(true);
    expect(report.counts.sanitised).toBe(1);

    await inA(() => commitImport(report.id));
    const [stored] = (await inA(() => listContacts({ limit: 50 }))).contacts;
    expect(stored?.name.startsWith('=')).toBe(false);
    expect(stored?.phoneE164).toBe('+919812345678');
  });

  it('commits once however many times it is asked', async () => {
    const csv = [
      HEADER,
      'Anita Rao,Blue Dart,anita@bluedart.co.in,,FREIGHT_FORWARDER,INTERNATIONAL',
      'Ravi Menon,Gati,ravi@gati.in,,CUSTOMS_BROKER,INTERNATIONAL',
    ].join('\r\n');

    const report = await inA(() => validateImport({ mode: 'UPSERT', fileName: null, csv }));
    const first = await inA(() => commitImport(report.id));
    const second = await inA(() => commitImport(report.id));

    expect(first.state).toBe('COMMITTED');
    expect(second.committedAt).toBe(first.committedAt);
    expect((await inA(() => listContacts({ limit: 50 }))).contacts).toHaveLength(2);

    const { entries } = await inA(() => listAudit({ limit: 50, action: 'CONTACTS_IMPORTED' }));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toMatchObject({ total: 2, created: 2 });
  });

  it('survives two commits racing each other', async () => {
    const csv = [HEADER, 'Anita Rao,Blue Dart,anita@bluedart.co.in,,FREIGHT_FORWARDER,INTERNATIONAL'].join('\r\n');
    const report = await inA(() => validateImport({ mode: 'UPSERT', fileName: null, csv }));

    const [left, right] = await Promise.all([
      inA(() => commitImport(report.id)),
      inA(() => commitImport(report.id)),
    ]);

    expect(left.state).toBe('COMMITTED');
    expect(right.state).toBe('COMMITTED');
    expect((await inA(() => listContacts({ limit: 50 }))).contacts).toHaveLength(1);
  });

  it('updates an address already on file in UPSERT, and leaves it alone in CREATE_ONLY', async () => {
    await inA(() =>
      createContact({
        name: 'Anita Rao',
        company: 'Blue Dart',
        email: 'anita@bluedart.co.in',
        phone: null,
        customerType: 'FREIGHT_FORWARDER',
        formScope: 'INTERNATIONAL',
      }),
    );

    const row = 'Anita R,Blue Dart Aviation,anita@bluedart.co.in,,FREIGHT_FORWARDER,INTERNATIONAL';

    const createOnly = await inA(() =>
      validateImport({ mode: 'CREATE_ONLY', fileName: null, csv: [HEADER, row].join('\r\n') }),
    );
    expect(createOnly.counts).toMatchObject({ skip: 1, update: 0 });
    expect(createOnly.rows[0]?.problems[0]).toMatchObject({ code: 'ALREADY_ON_FILE' });
    await inA(() => commitImport(createOnly.id));
    expect((await inA(() => listContacts({ limit: 50 }))).contacts[0]?.company).toBe('Blue Dart');

    const upsert = await inA(() =>
      validateImport({ mode: 'UPSERT', fileName: null, csv: [HEADER, row].join('\r\n') }),
    );
    expect(upsert.counts).toMatchObject({ update: 1, create: 0 });
    await inA(() => commitImport(upsert.id));

    const after = (await inA(() => listContacts({ limit: 50 }))).contacts;
    expect(after).toHaveLength(1);
    expect(after[0]?.company).toBe('Blue Dart Aviation');
  });

  it('never lets a re-import clear a bounce or a suppression', async () => {
    const created = await inA(() =>
      createContact({
        name: 'Anita Rao',
        company: 'Blue Dart',
        email: 'anita@bluedart.co.in',
        phone: null,
        customerType: 'FREIGHT_FORWARDER',
        formScope: 'INTERNATIONAL',
      }),
    );
    await inA(() => updateContact(created.id, { status: 'SUPPRESSED' }));

    const csv = [HEADER, 'Anita Rao,Blue Dart,anita@bluedart.co.in,,FREIGHT_FORWARDER,INTERNATIONAL'].join('\r\n');
    const report = await inA(() => validateImport({ mode: 'UPSERT', fileName: null, csv }));
    await inA(() => commitImport(report.id));

    expect((await inA(() => listContacts({ limit: 50 }))).contacts[0]?.status).toBe('SUPPRESSED');
  });

  it('accepts parsed rows as well as a file, and marks them as imported', async () => {
    const report = await inA(() =>
      validateImport({
        mode: 'UPSERT',
        fileName: null,
        rows: [
          {
            name: 'Ravi Menon',
            company: 'Gati',
            email: 'ravi@gati.in',
            customerType: 'customs broker',
            formScope: 'domestic',
          },
        ],
      }),
    );
    expect(report.rows[0]?.outcome).toBe('CREATE');

    await inA(() => commitImport(report.id));
    const [stored] = (await inA(() => listContacts({ limit: 50 }))).contacts;
    expect(stored).toMatchObject({ customerType: 'CUSTOMS_BROKER', formScope: 'DOMESTIC', source: 'IMPORT' });
  });

  it('keeps one organisation import out of another', async () => {
    const csv = [HEADER, 'Anita Rao,Blue Dart,anita@bluedart.co.in,,FREIGHT_FORWARDER,INTERNATIONAL'].join('\r\n');
    const report = await inA(() => validateImport({ mode: 'UPSERT', fileName: null, csv }));

    await expect(inB(() => commitImport(report.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await inA(() => listContacts({ limit: 50 }))).contacts).toHaveLength(0);
  });
});

describe('sampling batches', () => {

  it('refuses to lock a sample below the cycle minimum, and says how many more are needed', async () => {
    await openCycle(5);
    const ids = await addContacts(8);
    const batchId = await draftBatch();
    await inA(() => setSelection(batchId, ids.slice(0, 3)));

    const gate = await inA(() => previewGate(batchId));
    expect(gate).toMatchObject({ ok: false, reason: 'BELOW_MINIMUM', needed: 2, eligibleCount: 8 });
    expect(gate.explanation).toContain('Select 2 more');

    await expect(inA(() => lockBatch(batchId, new Date()))).rejects.toMatchObject({
      code: 'SAMPLING_BELOW_MINIMUM',
    });
    expect((await inA(() => readBatch(batchId))).state).toBe('DRAFT');
  });

  it('makes an operator with fewer customers than the minimum lock all of them, and records the shortfall', async () => {
    await openCycle(5);
    const ids = await addContacts(3);
    const batchId = await draftBatch();

    await inA(() => setSelection(batchId, ids.slice(0, 2)));
    await expect(inA(() => lockBatch(batchId, new Date()))).rejects.toMatchObject({
      code: 'SAMPLING_BELOW_MINIMUM',
    });

    await inA(() => setSelection(batchId, ids));
    const locked = await inA(() => lockBatch(batchId, new Date()));

    expect(locked.lockGate).toMatchObject({ ok: true, mustSelectAll: true, shortfall: 2 });
    expect(locked.state).toBe('PENDING_REVIEW');
  });

  it('refuses a batch with an empty directory', async () => {
    await openCycle(5);
    const batchId = await draftBatch();

    const gate = await inA(() => previewGate(batchId));
    expect(gate).toMatchObject({ ok: false, reason: 'EMPTY_DIRECTORY' });
  });

  it('locks once however many times it is asked', async () => {
    await openCycle(3);
    const ids = await addContacts(4);
    const batchId = await draftBatch();
    await inA(() => setSelection(batchId, ids));

    const first = await inA(() => lockBatch(batchId, new Date()));
    const second = await inA(() => lockBatch(batchId, new Date(Date.now() + 1000)));

    expect(second.lockedAt).toBe(first.lockedAt);
    expect(second.submittedCount).toBe(4);

    const { entries } = await inA(() => listAudit({ limit: 50, action: 'BATCH_LOCKED' }));
    expect(entries).toHaveLength(1);
  });

  it('freezes the selection at the lock', async () => {
    await openCycle(3);
    const ids = await addContacts(4);
    const batchId = await draftBatch();
    await inA(() => setSelection(batchId, ids));
    await inA(() => lockBatch(batchId, new Date()));

    await expect(inA(() => setSelection(batchId, ids.slice(0, 3)))).rejects.toMatchObject({
      code: 'BATCH_ALREADY_LOCKED',
    });
  });

  it('refuses a selection that is not an active contact of this organisation', async () => {
    await openCycle(3);
    const ids = await addContacts(3);
    const batchId = await draftBatch();

    await inA(() => deactivateContact(ids[0] ?? ''));
    await expect(inA(() => setSelection(batchId, ids))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const theirs = await inB(() =>
      createContact({
        name: 'Elsewhere',
        company: 'Other terminal customer',
        email: 'elsewhere@other.in',
        phone: null,
        customerType: 'CUSTOMS_BROKER',
        formScope: 'INTERNATIONAL',
      }),
    );
    await expect(inA(() => setSelection(batchId, [theirs.id]))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('approves on the spot when the organisation has chosen AUTO', async () => {
    await openCycle(3);
    await inA(() => patchSamplingSettings({ approvalMode: 'AUTO' }));

    const ids = await addContacts(3);
    const batchId = await draftBatch();
    await inA(() => setSelection(batchId, ids));
    const locked = await inA(() => lockBatch(batchId, new Date()));

    expect(locked).toMatchObject({ state: 'APPROVED', approvalMode: 'AUTO' });
    expect(locked.decidedAt).not.toBeNull();
  });

  it('carries a reviewer add, remove and correction into a diff against what was submitted', async () => {
    await openCycle(3);
    const ids = await addContacts(5);
    const batchId = await draftBatch();
    await inA(() => setSelection(batchId, ids.slice(0, 4)));
    await inA(() => lockBatch(batchId, new Date()));

    const spare = ids[4] ?? '';
    const dropped = ids[0] ?? '';
    const corrected = ids[1] ?? '';

    await asReviewer(() => reviewAdd(batchId, [spare], 'ADDED_MISSING_CUSTOMER', 'left off the list'));
    await asReviewer(() => reviewRemove(batchId, [dropped], 'REMOVED_RELATED_PARTY', null));
    await asReviewer(() =>
      reviewCorrect(batchId, corrected, { company: 'Corrected Forwarder' }, 'CORRECTED_CONTACT_DETAILS', null),
    );

    const diff = await inA(() => diffBatch(batchId));
    expect(diff.submittedCount).toBe(4);
    expect(diff.currentCount).toBe(4);
    expect(diff.added.map((row) => row.id)).toEqual([spare]);
    expect(diff.removed.map((row) => row.id)).toEqual([dropped]);
    expect(diff.corrected[0]).toMatchObject({ contactId: corrected, fields: ['company'], by: 'reviewer' });
    expect(diff.changes.map((change) => change.reasonCode)).toEqual([
      'ADDED_MISSING_CUSTOMER',
      'REMOVED_RELATED_PARTY',
      'CORRECTED_CONTACT_DETAILS',
    ]);

    const approved = await asReviewer(() => approveBatch(batchId, 'looks right now'));
    expect(approved.state).toBe('APPROVED');
    expect(approved.decidedBy).toBe('reviewer');
  });

  it('runs the gate again at approval, so review cannot quietly shrink a sample below the minimum', async () => {
    await openCycle(4);
    const ids = await addContacts(6);
    const batchId = await draftBatch();
    await inA(() => setSelection(batchId, ids.slice(0, 4)));
    await inA(() => lockBatch(batchId, new Date()));

    await asReviewer(() => reviewRemove(batchId, ids.slice(0, 2), 'REMOVED_NOT_A_CUSTOMER', null));
    await expect(asReviewer(() => approveBatch(batchId, null))).rejects.toMatchObject({
      code: 'SAMPLING_BELOW_MINIMUM',
    });

    await asReviewer(() => reviewAdd(batchId, ids.slice(4), 'ADDED_FOR_COVERAGE', null));
    expect((await asReviewer(() => approveBatch(batchId, null))).state).toBe('APPROVED');
  });

  it('rejects with structure, and a rejected sample stops counting toward the cycle', async () => {
    await openCycle(3);
    const ids = await addContacts(6);
    const first = await draftBatch();
    await inA(() => setSelection(first, ids.slice(0, 3)));
    await inA(() => lockBatch(first, new Date()));

    const rejected = await asReviewer(() =>
      rejectBatch(first, {
        reasonCode: 'RELATED_PARTIES_INCLUDED',
        findings: [{ contactId: ids[0] ?? null, detail: 'Shares the operator domain' }],
        note: null,
      }),
    );
    expect(rejected.state).toBe('REJECTED');
    expect(rejected.rejection).toMatchObject({ reasonCode: 'RELATED_PARTIES_INCLUDED' });

    const second = await draftBatch();
    await inA(() => setSelection(second, ids.slice(3, 5)));
    const gate = await inA(() => previewGate(second));

    expect(gate.cumulativeSelectedCount).toBe(2);
    expect(gate.ok).toBe(false);
  });

  it('counts the whole cycle when a repeat batch samples customers added after assessment opened', async () => {
    const now = new Date();
    await openCycle(5, now);
    expect((await inA(() => readCyclePolicy(CYCLE, now))).assessmentOpen).toBe(true);

    const early = await addContacts(5, { prefix: 'early' });
    const first = await draftBatch();
    await inA(() => setSelection(first, early));
    await inA(() => lockBatch(first, now));
    await asReviewer(() => approveBatch(first, null));

    // two late arrivals, added while the assessment window is already open
    const late = await addContacts(2, { prefix: 'late' });
    const second = await draftBatch();
    await inA(() => setSelection(second, late));

    const gate = await inA(() => previewGate(second));
    expect(gate).toMatchObject({ ok: true, selectedCount: 2, cumulativeSelectedCount: 7, eligibleCount: 7 });

    const locked = await inA(() => lockBatch(second, now));
    expect(locked.state).toBe('PENDING_REVIEW');
    expect((await inA(() => listBatches({ limit: 50, cycleId: CYCLE }))).batches).toHaveLength(2);
  });

  it('records integrity observations as counts, including the zeroes', async () => {
    const now = new Date();
    await openCycle(3, now);
    await inA(() =>
      patchSamplingSettings({
        operatorDomains: ['terminalone.in'],
        freeMailDomains: ['gmail.com'],
        burstWindowMinutes: 60,
      }),
    );

    const own = await addContacts(1, { domain: 'terminalone.in', prefix: 'own' });
    const free = await addContacts(1, { domain: 'gmail.com', prefix: 'free' });
    const shared = await addContacts(2, { phone: '+919812345678', prefix: 'shared' });

    const batchId = await draftBatch();
    await inA(() => setSelection(batchId, [...own, ...free, ...shared]));
    await inA(() => lockBatch(batchId, new Date()));

    const integrity = await inA(() => readIntegrity(batchId));
    const bySignal = new Map(integrity.occurrences.map((row) => [row.signal, row]));

    expect(integrity.contactsConsidered).toBe(4);
    expect(bySignal.get('OPERATOR_DOMAIN_MATCH')).toMatchObject({ count: 1, denominator: 4 });
    expect(bySignal.get('FREE_MAIL_DOMAIN')).toMatchObject({ count: 1, denominator: 4 });
    expect(bySignal.get('DUPLICATE_PHONE')).toMatchObject({ count: 2, denominator: 2 });
    expect(bySignal.get('ADDED_IN_BURST_BEFORE_LOCK')).toMatchObject({ count: 4, denominator: 4 });
    expect(bySignal.get('MISSING_PHONE')).toMatchObject({ count: 2, denominator: 4 });

    // no weighted total anywhere: the weights are to be fitted, not invented
    expect(Object.keys(integrity)).not.toContain('score');
  });

  it('will not open or lock a sample outside the sampling window', async () => {
    const now = new Date();
    await openCycle(3, now);
    const ids = await addContacts(3);
    const batchId = await draftBatch();
    await inA(() => setSelection(batchId, ids));

    await inA(() =>
      putCyclePolicy(CYCLE, {
        minimumSamplingSize: 3,
        samplingOpens: boundary(new Date(now.getTime() - 30 * DAY)),
        samplingCloses: boundary(new Date(now.getTime() - 20 * DAY)),
        assessmentOpens: boundary(new Date(now.getTime() - 25 * DAY)),
        assessmentCloses: boundary(new Date(now.getTime() - DAY)),
      }),
    );

    await expect(inA(() => lockBatch(batchId, now))).rejects.toMatchObject({ code: 'WINDOW_CLOSED' });
    await expect(
      inA(() => createBatch({ cycleId: CYCLE, formScope: 'INTERNATIONAL', label: null }, now)),
    ).rejects.toMatchObject({ code: 'WINDOW_CLOSED' });
  });

  it('answers a read of another organisation batch as if it never existed', async () => {
    await openCycle(3);
    const batchId = await draftBatch();
    await expect(inB(() => readBatch(batchId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a batch for a cycle with no sampling policy', async () => {
    await expect(
      inA(() => createBatch({ cycleId: newId(), formScope: 'INTERNATIONAL', label: null }, new Date())),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('sampling settings and cycle policy', () => {

  it('starts an organisation on review required rather than on the weaker setting', async () => {
    expect((await inA(() => readSamplingSettings())).approvalMode).toBe('SUPER_ADMIN');
  });

  it('keeps one organisation settings out of another', async () => {
    await inA(() => patchSamplingSettings({ approvalMode: 'AUTO', operatorDomains: ['terminalone.in'] }));

    expect((await inA(() => readSamplingSettings())).approvalMode).toBe('AUTO');
    expect((await inB(() => readSamplingSettings())).approvalMode).toBe('SUPER_ADMIN');
    expect((await inB(() => readSamplingSettings())).operatorDomains).toEqual([]);
  });

  it('refuses an instant that does not match the wall time it claims', async () => {
    const now = new Date();
    const policy = openCyclePolicy(now, 5);

    await expect(
      inA(() =>
        putCyclePolicy(newId(), {
          ...policy,
          samplingOpens: { ...policy.samplingOpens, wall: '2026-01-01T00:00:00' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a zone this server does not know', async () => {
    const now = new Date();
    const policy = openCyclePolicy(now, 5);

    await expect(
      inA(() =>
        putCyclePolicy(newId(), {
          ...policy,
          samplingCloses: { ...policy.samplingCloses, tz: 'Mars/Olympus' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses windows that are out of order', async () => {
    const now = new Date();
    await expect(
      inA(() =>
        putCyclePolicy(newId(), {
          minimumSamplingSize: 5,
          samplingOpens: boundary(new Date(now.getTime() + 5 * DAY)),
          samplingCloses: boundary(new Date(now.getTime() + 10 * DAY)),
          // assessment cannot begin before sampling has opened
          assessmentOpens: boundary(new Date(now.getTime() + DAY)),
          assessmentCloses: boundary(new Date(now.getTime() + 20 * DAY)),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('allows the assessment window to open before sampling closes, which repeat sampling needs', async () => {
    const now = new Date();
    const cycleId = newId();
    const saved = await inA(() => putCyclePolicy(cycleId, openCyclePolicy(now, 5)));

    expect(saved.samplingOpen).toBe(true);
    expect(saved.assessmentOpen).toBe(true);
    expect(saved.samplingOpens.tz).toBe(TZ);

    const reread = await inA(() => readCyclePolicy(cycleId, now));
    expect(reread.minimumSamplingSize).toBe(5);
  });

  it('answers a policy read for a cycle this organisation has not set as not found', async () => {
    const cycleId = newId();
    await inA(() => putCyclePolicy(cycleId, openCyclePolicy(new Date(), 5)));

    await expect(inB(() => readCyclePolicy(cycleId, new Date()))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('sampling route policy', () => {
  it('passes the boot time check, so no route can be mounted unprotected', () => {
    expect(() => checkModule(samplingModule)).not.toThrow();
  });

  it('declares every capability its routes require, and requires one on every route', () => {
    const declared = new Set(samplingModule.capabilities);
    for (const route of samplingModule.routes) {
      expect(route.policy.tenancy).toBe('ORG');
      expect(route.policy.requiredCapability).not.toBeNull();
      expect(declared.has(route.policy.requiredCapability ?? '')).toBe(true);
    }
  });

  it('registers each method and path once', () => {
    const keys = samplingModule.routes.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps reviewing a sample apart from building one', () => {
    const reviewRoutes = samplingModule.routes.filter((route) => route.policy.requiredCapability === 'sampling:review');
    const paths = reviewRoutes.map((route) => route.path).sort();

    expect(paths).toEqual([
      '/batches/:batchId/approve',
      '/batches/:batchId/reject',
      '/batches/:batchId/review/add',
      '/batches/:batchId/review/correct',
      '/batches/:batchId/review/remove',
    ]);
    for (const route of samplingModule.routes) {
      if (route.path === '/batches/:batchId/lock') {
        expect(route.policy.requiredCapability).toBe('sampling.batches:write');
      }
    }
  });
});
