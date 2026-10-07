import type { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { withTransaction } from '../src/core/db.js';
import { on, type Events } from '../src/core/events.js';
import { idString } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { CustomerModel } from '../src/modules/customers/customers.model.js';
import { CycleParticipantModel } from '../src/modules/cycles/cycle-participants.model.js';
import { CycleModel } from '../src/modules/cycles/cycles.model.js';
import type { CycleStatus, CycleType } from '../src/modules/cycles/domain/types.js';
import { createParticipants, planParticipants } from '../src/modules/cycles/participants.service.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import type { OrganisationDoc } from '../src/modules/organisations/organisations.model.js';
import { SampleModel } from '../src/modules/sampling/sampling.model.js';
import { getSelection, isSamplingOpen } from '../src/modules/sampling/sampling.service.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { expectError, grantTasks } from './helpers/fixtures.js';

// Bridge until the scoring agent lands `scoring.service.ts`: reports imports
// it and the module registry imports reports, so the app cannot boot without
// it. The real reports module is used untouched once it loads; until then a
// route-less stand-in takes its slot. Sampling itself never touches either.
vi.mock('../src/modules/reports/index.js', async (importOriginal) => {
  try {
    return await importOriginal<Record<string, unknown>>();
  } catch {
    return { default: { name: 'reports', basePath: '/', tasks: [], routes: [] } };
  }
});

const DAY = 24 * 60 * 60 * 1000;
const SAMPLING = '/api/v1/sampling/cycles';

let t: TestApp;
let superAdmin: TestUser;
let adminA: TestUser;
let userA: TestUser;
let adminB: TestUser;
let acoA: string;
let acoB: string;

const lockedEvents: { payload: Events['sample.locked']; inSession: boolean }[] = [];
const unlockedEvents: { payload: Events['sample.unlocked']; inSession: boolean }[] = [];
let failNextLock = false;

interface CycleInput {
  code: string;
  type: CycleType;
  minSampleSize: number;
  status: CycleStatus;
  samplingStart?: Date;
  samplingEnd?: Date;
}

const edge = (at: Date) => ({ wall: at.toISOString().slice(0, 16), utc: at });

/** A cycle straight in the database with its participants created by the real cycles rules. */
async function createCycle(input: CycleInput, operators: OrganisationDoc[]): Promise<string> {
  const start = input.samplingStart ?? new Date(Date.now() - DAY);
  const end = input.samplingEnd ?? new Date(Date.now() + 10 * DAY);
  const cycle = await CycleModel.create({
    name: `Cycle ${input.code}`,
    code: input.code,
    type: input.type,
    tz: 'Asia/Kolkata',
    sampling: { start: edge(start), end: edge(end) },
    assessment: { start: edge(end), end: edge(new Date(end.getTime() + 30 * DAY)) },
    minSampleSize: input.minSampleSize,
    reminders: { sampling: { count: 3, everyDays: 3 }, assessment: { count: 10, everyDays: 2 } },
    participatingAirportIds: [...new Set(operators.map((op) => idString(op.airportId as Types.ObjectId)))],
    participatingAcoIds: operators.map((op) => op._id),
    status: input.status,
    publishedAt: new Date(),
  });
  await withTransaction(async (session) => {
    await createParticipants(cycle._id, planParticipants({ type: input.type, minSampleSize: input.minSampleSize }, operators), session);
  });
  return idString(cycle._id);
}

async function createCustomer(as: TestUser, overrides: Record<string, unknown>): Promise<string> {
  const res = await as.post('/api/v1/customers').send({
    name: 'Customer',
    contactPerson: 'Contact',
    phone: '+91 98765 43210',
    type: 'FF',
    surveyType: 'BOTH',
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

const item = (customerId: string, surveyType: 'DOMESTIC' | 'INTERNATIONAL') => ({ customerId, surveyType });

let cycleId: string;
let cBoth: string;
let cDom: string;
let cIntl: string;
let cInactive: string;
let cOther: string;

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  adminA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'SMP-A', airportIata: 'DEL', name: 'Asha Rao' });
  userA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_USER', orgCode: 'SMP-A', airportIata: 'DEL' });
  adminB = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'SMP-B', airportIata: 'BOM' });
  acoA = idString(adminA.org._id);
  acoB = idString(adminB.org._id);

  on('sample.locked', 'test.sampling.recorder', async (payload, meta) => {
    if (failNextLock) throw new Error('listener failed on purpose');
    lockedEvents.push({ payload, inSession: meta.session !== undefined });
  });
  on('sample.unlocked', 'test.sampling.recorder', async (payload, meta) => {
    unlockedEvents.push({ payload, inSession: meta.session !== undefined });
  });

  cycleId = await createCycle({ code: 'SMP-BOTH', type: 'BOTH', minSampleSize: 3, status: 'SAMPLING_OPEN' }, [adminA.org, adminB.org]);
  cBoth = await createCustomer(adminA, { name: 'Both Ways Logistics', email: 'both@a.test', surveyType: 'BOTH' });
  cDom = await createCustomer(adminA, { name: 'Domestic Brokers', email: 'dom@a.test', surveyType: 'DOMESTIC', type: 'CB' });
  cIntl = await createCustomer(adminA, { name: 'Intl Forwarders', email: 'intl@a.test', surveyType: 'INTERNATIONAL' });
  cInactive = await createCustomer(adminA, { name: 'Gone Cargo', email: 'gone@a.test', surveyType: 'BOTH' });
  await adminA.post(`/api/v1/customers/${cInactive}/deactivate`);
  cOther = await createCustomer(adminB, { name: 'Other Operator Customer', email: 'other@b.test', surveyType: 'BOTH' });
});
afterAll(() => t.close());

describe('GET /sampling/cycles/:cycleId', () => {
  it('returns the selection state with BOTH customers expanded into two eligible entries', async () => {
    const res = await adminA.get(`${SAMPLING}/${cycleId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      cycle: { id: cycleId, code: 'SMP-BOTH', type: 'BOTH', status: 'SAMPLING_OPEN' },
      participant: { cycleId, acoId: acoA, surveyTypes: ['DOMESTIC', 'INTERNATIONAL'], requiredSampleSize: 3, sampling: { status: 'NOT_STARTED', selectedCount: 0 } },
      required: 3,
      selectedCount: 0,
      eligibleCount: 4,
      lockable: false,
      reason: 'NOTHING_SELECTED',
      shortfallRule: null,
      remaining: 3,
      target: 3,
      progress: '0 / 3',
      progressPct: 0,
      editable: true,
      selection: [],
    });
  });

  it('is tenant-scoped: ACO B sees its own empty state, cannot name A, and PLATFORM must name an operator', async () => {
    const own = await adminB.get(`${SAMPLING}/${cycleId}`);
    expect(own.status).toBe(200);
    expect(own.body.data.participant.acoId).toBe(acoB);
    expect(own.body.data.eligibleCount).toBe(2);
    expectError(await adminB.get(`${SAMPLING}/${cycleId}?acoId=${acoA}`), 404, 'NOT_FOUND');
    expectError(await adminA.get(`${SAMPLING}/0123456789abcdef01234567`), 404, 'NOT_FOUND');
    expectError(await superAdmin.get(`${SAMPLING}/${cycleId}`), 400, 'VALIDATION');
    const platform = await superAdmin.get(`${SAMPLING}/${cycleId}?acoId=${acoA}`);
    expect(platform.status).toBe(200);
    expect(platform.body.data.participant.acoId).toBe(acoA);
  });

  it('exposes getSelection(cycleId, acoId) for other features', async () => {
    const state = await getSelection(cycleId, acoB);
    expect(state.participant.acoId).toBe(acoB);
    expect(state.eligibleCount).toBe(2);
  });
});

describe('PUT /sampling/cycles/:cycleId/selection', () => {
  it('adds eligible entries and returns every rejected item with a reason', async () => {
    const res = await adminA.put(`${SAMPLING}/${cycleId}/selection`).send({
      add: [
        item(cBoth, 'DOMESTIC'),
        item(cBoth, 'INTERNATIONAL'),
        item(cDom, 'INTERNATIONAL'),
        item(cInactive, 'DOMESTIC'),
        item(cOther, 'DOMESTIC'),
        item(cBoth, 'DOMESTIC'),
      ],
      remove: [item(cIntl, 'INTERNATIONAL')],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.added).toEqual([item(cBoth, 'DOMESTIC'), item(cBoth, 'INTERNATIONAL')]);
    expect(res.body.data.removed).toEqual([]);
    expect((res.body.data.rejected as { customerId: string; op: string; reason: string }[]).map((r) => [r.customerId, r.op, r.reason])).toEqual([
      [cBoth, 'add', 'DUPLICATE_IN_REQUEST'],
      [cIntl, 'remove', 'NOT_SELECTED'],
      [cDom, 'add', 'WRONG_SURVEY_TYPE'],
      [cInactive, 'add', 'INACTIVE_CUSTOMER'],
      [cOther, 'add', 'UNKNOWN_CUSTOMER'],
    ]);
    expect(res.body.data.state).toMatchObject({
      selectedCount: 2,
      lockable: false,
      reason: 'BELOW_MINIMUM',
      remaining: 1,
      progress: '2 / 3',
      progressPct: 67,
      participant: { sampling: { status: 'IN_PROGRESS', selectedCount: 2 } },
    });
    const rows = res.body.data.state.selection as { customer: { name: string }; surveyType: string; state: string }[];
    expect(rows.map((r) => [r.customer.name, r.surveyType, r.state])).toEqual([
      ['Both Ways Logistics', 'DOMESTIC', 'SELECTED'],
      ['Both Ways Logistics', 'INTERNATIONAL', 'SELECTED'],
    ]);

    const audit = await AuditModel.findOne({ action: 'sample.selection.changed', entityId: cycleId }).lean();
    expect(audit).not.toBeNull();
    expect(idString(audit!.orgId!)).toBe(acoA);
    expect(audit!.actorEmail).toBe(adminA.user.email);
    expect((audit!.after as { added: unknown[] }).added).toHaveLength(2);
  });

  it('removes and re-adds through the same unique row, and audits nothing when nothing changed', async () => {
    const before = await AuditModel.countDocuments({ action: 'sample.selection.changed' });
    const removed = await adminA.put(`${SAMPLING}/${cycleId}/selection`).send({ remove: [item(cBoth, 'INTERNATIONAL')] });
    expect(removed.body.data.removed).toEqual([item(cBoth, 'INTERNATIONAL')]);
    expect(removed.body.data.state.selectedCount).toBe(1);
    expect(await SampleModel.countDocuments({ cycleId, acoId: acoA, state: 'REMOVED' })).toBe(1);

    const readded = await adminA.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [item(cBoth, 'INTERNATIONAL')] });
    expect(readded.body.data.added).toEqual([item(cBoth, 'INTERNATIONAL')]);
    expect(await SampleModel.countDocuments({ cycleId, acoId: acoA })).toBe(2);

    const noop = await adminA.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [item(cBoth, 'INTERNATIONAL')] });
    expect(noop.body.data.rejected[0].reason).toBe('ALREADY_SELECTED');
    expect(await AuditModel.countDocuments({ action: 'sample.selection.changed' })).toBe(before + 2);
  });

  it('needs sampling.manage and the right organisation', async () => {
    expectError(await userA.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [item(cDom, 'DOMESTIC')] }), 403, 'FORBIDDEN');
    expectError(await adminB.put(`${SAMPLING}/${cycleId}/selection`).send({ acoId: acoA, add: [item(cDom, 'DOMESTIC')] }), 404, 'NOT_FOUND');
    expectError(await adminA.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [{ customerId: 'nope', surveyType: 'DOMESTIC' }] }), 400, 'VALIDATION');
    expect(await SampleModel.countDocuments({ cycleId, acoId: acoB })).toBe(0);
  });
});

describe('POST /sampling/cycles/:cycleId/lock', () => {
  it('is refused below the minimum, leaving the participant untouched', async () => {
    const error = expectError(await adminA.post(`${SAMPLING}/${cycleId}/lock`), 412, 'PRECONDITION_FAILED');
    expect(error.details).toMatchObject({ reason: 'BELOW_MINIMUM', required: 3, selectedCount: 2, remaining: 1 });
    const participant = await CycleParticipantModel.findOne({ cycleId, acoId: acoA }).lean();
    expect(participant!.sampling.status).toBe('IN_PROGRESS');
    expect(lockedEvents).toHaveLength(0);
  });

  it('is one transaction: a failing sample.locked listener leaves nothing persisted', async () => {
    const reached = await adminA.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [item(cDom, 'DOMESTIC')] });
    expect(reached.body.data.state).toMatchObject({ selectedCount: 3, lockable: true, reason: null });

    failNextLock = true;
    try {
      const res = await adminA.post(`${SAMPLING}/${cycleId}/lock`);
      expect(res.status).toBe(500);
    } finally {
      failNextLock = false;
    }
    expect(await SampleModel.countDocuments({ cycleId, acoId: acoA, state: 'LOCKED' })).toBe(0);
    expect(await SampleModel.countDocuments({ cycleId, acoId: acoA, state: 'SELECTED' })).toBe(3);
    const participant = await CycleParticipantModel.findOne({ cycleId, acoId: acoA }).lean();
    expect(participant!.sampling).toMatchObject({ status: 'IN_PROGRESS', lockedAt: null, lockedBy: null });
    expect(await AuditModel.countDocuments({ action: 'sample.locked' })).toBe(0);
    expect(await NotificationModel.countDocuments({ template: 'sample-locked' })).toBe(0);
    expect((await CustomerModel.findById(cDom).lean())!.lastSampledCycleId).toBeNull();
  });

  it('locks: samples LOCKED, participant LOCKED, event with the samples list, audit row, e-mail to the ACO admin', async () => {
    const res = await adminA.post(`${SAMPLING}/${cycleId}/lock`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      selectedCount: 3,
      lockable: false,
      reason: 'ALREADY_LOCKED',
      editable: false,
      participant: { sampling: { status: 'LOCKED', selectedCount: 3, lockedBy: idString(adminA.user._id) } },
    });
    expect(res.body.data.participant.sampling.lockedAt).toBeTruthy();
    expect((res.body.data.selection as { state: string }[]).every((row) => row.state === 'LOCKED')).toBe(true);

    expect(lockedEvents).toHaveLength(1);
    const event = lockedEvents[0]!;
    expect(event.inSession).toBe(true);
    expect(event.payload).toMatchObject({ cycleId, acoId: acoA });
    expect(event.payload.samples.map((s) => [s.customerId, s.surveyType])).toEqual([
      [cBoth, 'DOMESTIC'],
      [cBoth, 'INTERNATIONAL'],
      [cDom, 'DOMESTIC'],
    ]);
    const locked = await SampleModel.find({ cycleId, acoId: acoA, state: 'LOCKED' }).lean();
    expect(locked.map((s) => idString(s._id)).sort()).toEqual(event.payload.samples.map((s) => s.sampleId).sort());

    const audit = await AuditModel.findOne({ action: 'sample.locked', entityId: cycleId }).lean();
    expect(audit).not.toBeNull();
    expect(idString(audit!.orgId!)).toBe(acoA);
    expect(audit!.before).toMatchObject({ status: 'IN_PROGRESS' });
    expect(audit!.after).toMatchObject({ status: 'LOCKED', selectedCount: 3, required: 3, eligibleCount: 4 });

    const mails = await NotificationModel.find({ template: 'sample-locked' }).lean();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: adminA.user.email, status: 'SENT' });
    expect(mails[0]!.subject).toBe('Sample locked for Cycle SMP-BOTH');
    expect(mails[0]!.body).toContain('Participants selected: 3 (minimum required: 3)');
    expect(mails[0]!.body).toContain('locked by Asha Rao');
    expect(idString(mails[0]!.refs.cycleId!)).toBe(cycleId);
    expect(idString(mails[0]!.refs.acoId!)).toBe(acoA);

    expect(idString((await CustomerModel.findById(cDom).lean())!.lastSampledCycleId!)).toBe(cycleId);
    expect((await CustomerModel.findById(cIntl).lean())!.lastSampledCycleId).toBeNull();
  });

  it('refuses selection changes, select-all and a second lock while locked', async () => {
    const change = expectError(await adminA.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [item(cIntl, 'INTERNATIONAL')] }), 412, 'PRECONDITION_FAILED');
    expect(change.message).toContain('locked');
    expectError(await adminA.post(`${SAMPLING}/${cycleId}/select-all`), 412, 'PRECONDITION_FAILED');
    expect(expectError(await adminA.post(`${SAMPLING}/${cycleId}/lock`), 412, 'PRECONDITION_FAILED').message).toBe('The sample is already locked');
  });
});

describe('POST /sampling/cycles/:cycleId/unlock', () => {
  it('is PLATFORM only and needs a reason', async () => {
    await grantTasks('ACO_ADMIN', ['sampling.unlock']);
    expectError(await adminA.post(`${SAMPLING}/${cycleId}/unlock`).send({ acoId: acoA, reason: 'Trying from the operator side' }), 403, 'FORBIDDEN');
    expectError(await superAdmin.post(`${SAMPLING}/${cycleId}/unlock`).send({ acoId: acoA }), 400, 'VALIDATION');
    expectError(await superAdmin.post(`${SAMPLING}/${cycleId}/unlock`).send({ acoId: acoB, reason: 'Nothing to unlock here' }), 412, 'PRECONDITION_FAILED');
    expect((await CycleParticipantModel.findOne({ cycleId, acoId: acoA }).lean())!.sampling.status).toBe('LOCKED');
  });

  it('unlocks: samples back to SELECTED, participant UNLOCKED, event, audit, e-mail; the operator may edit and re-lock', async () => {
    const res = await superAdmin.post(`${SAMPLING}/${cycleId}/unlock`).send({ acoId: acoA, reason: 'Operator asked to swap a broker' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      editable: true,
      lockable: true,
      reason: null,
      participant: { sampling: { status: 'UNLOCKED', unlockedBy: idString(superAdmin.user._id), unlockReason: 'Operator asked to swap a broker' } },
    });
    expect((res.body.data.selection as { state: string }[]).every((row) => row.state === 'SELECTED')).toBe(true);
    expect(await SampleModel.countDocuments({ cycleId, acoId: acoA, state: 'LOCKED' })).toBe(0);

    expect(unlockedEvents).toHaveLength(1);
    expect(unlockedEvents[0]).toMatchObject({ inSession: true, payload: { cycleId, acoId: acoA, reason: 'Operator asked to swap a broker' } });

    const audit = await AuditModel.findOne({ action: 'sample.unlocked', entityId: cycleId }).lean();
    expect(audit!.actorEmail).toBe(superAdmin.user.email);
    expect(idString(audit!.orgId!)).toBe(acoA);
    expect(audit!.before).toMatchObject({ status: 'LOCKED' });
    expect(audit!.after).toMatchObject({ status: 'UNLOCKED', reason: 'Operator asked to swap a broker' });

    const mail = await NotificationModel.findOne({ template: 'sample-unlocked' }).lean();
    expect(mail).toMatchObject({ to: adminA.user.email, status: 'SENT', subject: 'Sample unlocked for Cycle SMP-BOTH' });
    expect(mail!.body).toContain('Reason: Operator asked to swap a broker');

    const swap = await adminA.put(`${SAMPLING}/${cycleId}/selection`).send({ remove: [item(cDom, 'DOMESTIC')], add: [item(cIntl, 'INTERNATIONAL')] });
    expect(swap.body.data.state.participant.sampling.status).toBe('UNLOCKED');
    expect(swap.body.data.state.selectedCount).toBe(3);
    const relocked = await adminA.post(`${SAMPLING}/${cycleId}/lock`);
    expect(relocked.status).toBe(200);
    expect(relocked.body.data.participant.sampling.status).toBe('LOCKED');
    expect(lockedEvents).toHaveLength(2);
    expect(lockedEvents[1]!.payload.samples.map((s) => s.customerId)).toEqual([cBoth, cBoth, cIntl]);
  });
});

describe('select-all and the shortfall rule', () => {
  let domesticCycle: string;

  beforeAll(async () => {
    domesticCycle = await createCycle({ code: 'SMP-DOM', type: 'DOMESTIC', minSampleSize: 10, status: 'SAMPLING_OPEN' }, [adminA.org]);
  });

  it('select-all is refused when enough customers are eligible', async () => {
    const error = expectError(await adminA.post(`${SAMPLING}/${cycleId}/select-all`), 412, 'PRECONDITION_FAILED');
    expect(error.message).toContain('locked');
    const stillOpen = await createCycle({ code: 'SMP-OPEN', type: 'BOTH', minSampleSize: 2, status: 'SAMPLING_OPEN' }, [adminA.org]);
    expect(expectError(await adminA.post(`${SAMPLING}/${stillOpen}/select-all`), 412, 'PRECONDITION_FAILED').details).toMatchObject({ eligibleCount: 4, required: 2 });
  });

  it('with fewer eligible than required the state says SELECT_ALL, select-all picks everyone and lock is allowed', async () => {
    const before = await adminA.get(`${SAMPLING}/${domesticCycle}`);
    expect(before.body.data).toMatchObject({ required: 10, eligibleCount: 2, shortfallRule: 'SELECT_ALL', target: 2, remaining: 2, reason: 'NOTHING_SELECTED' });

    const partial = await adminA.put(`${SAMPLING}/${domesticCycle}/selection`).send({ add: [item(cBoth, 'DOMESTIC'), item(cBoth, 'INTERNATIONAL')] });
    expect(partial.body.data.rejected[0].reason).toBe('WRONG_SURVEY_TYPE');
    expect(partial.body.data.state).toMatchObject({ selectedCount: 1, lockable: false, reason: 'SELECT_ALL_REQUIRED', remaining: 1 });
    expect(expectError(await adminA.post(`${SAMPLING}/${domesticCycle}/lock`), 412, 'PRECONDITION_FAILED').details).toMatchObject({ reason: 'SELECT_ALL_REQUIRED' });

    const all = await adminA.post(`${SAMPLING}/${domesticCycle}/select-all`);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.data.added).toEqual([item(cDom, 'DOMESTIC')]);
    expect(all.body.data.state).toMatchObject({ selectedCount: 2, eligibleCount: 2, lockable: true, reason: null, shortfallRule: 'SELECT_ALL', progress: '2 / 10', progressPct: 100 });

    const locked = await adminA.post(`${SAMPLING}/${domesticCycle}/lock`);
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body.data.participant.sampling.status).toBe('LOCKED');
    const audit = await AuditModel.findOne({ action: 'sample.locked', entityId: domesticCycle }).lean();
    expect(audit!.after).toMatchObject({ shortfallRule: 'SELECT_ALL', selectedCount: 2, required: 10 });
  });
});

describe('lock gate and sampling window', () => {
  it('never locks an empty selection', async () => {
    const empty = await createCycle({ code: 'SMP-EMPTY', type: 'INTERNATIONAL', minSampleSize: 1, status: 'SAMPLING_OPEN' }, [adminA.org]);
    const error = expectError(await adminA.post(`${SAMPLING}/${empty}/lock`), 412, 'PRECONDITION_FAILED');
    expect(error.details).toMatchObject({ reason: 'NOTHING_SELECTED' });
    expect(error.message).toContain('at least one');
  });

  it('allows changes only while sampling is open: SAMPLING_OPEN or PUBLISHED with the window running', async () => {
    const future = await createCycle({ code: 'SMP-FUTURE', type: 'BOTH', minSampleSize: 1, status: 'PUBLISHED', samplingStart: new Date(Date.now() + DAY) }, [adminA.org]);
    const state = await adminA.get(`${SAMPLING}/${future}`);
    expect(state.body.data).toMatchObject({ editable: false, lockable: false, reason: 'SAMPLING_CLOSED' });
    expect(expectError(await adminA.put(`${SAMPLING}/${future}/selection`).send({ add: [item(cBoth, 'DOMESTIC')] }), 412, 'PRECONDITION_FAILED').message).toContain('not open');
    expectError(await adminA.post(`${SAMPLING}/${future}/lock`), 412, 'PRECONDITION_FAILED');

    const running = await createCycle({ code: 'SMP-RUNNING', type: 'BOTH', minSampleSize: 1, status: 'PUBLISHED' }, [adminA.org]);
    const added = await adminA.put(`${SAMPLING}/${running}/selection`).send({ add: [item(cBoth, 'DOMESTIC')] });
    expect(added.status).toBe(200);
    expect(added.body.data.state.editable).toBe(true);

    const closed = await createCycle({ code: 'SMP-CLOSED', type: 'BOTH', minSampleSize: 1, status: 'SAMPLING_CLOSED', samplingEnd: new Date(Date.now() - 1) }, [adminA.org]);
    expectError(await adminA.put(`${SAMPLING}/${closed}/selection`).send({ add: [item(cBoth, 'DOMESTIC')] }), 412, 'PRECONDITION_FAILED');
    expect(isSamplingOpen({ id: closed, code: 'X', name: 'X', type: 'BOTH', status: 'SAMPLING_CLOSED', samplingStart: null, samplingEnd: null })).toBe(false);
  });

  it('an UNLOCKED participant may edit and re-lock after the window closed, until the assessment closes', async () => {
    const closing = await createCycle({ code: 'SMP-REOPEN', type: 'DOMESTIC', minSampleSize: 1, status: 'SAMPLING_OPEN' }, [adminA.org]);
    await adminA.put(`${SAMPLING}/${closing}/selection`).send({ add: [item(cBoth, 'DOMESTIC')] });
    expect((await adminA.post(`${SAMPLING}/${closing}/lock`)).status).toBe(200);
    await CycleModel.updateOne({ _id: closing }, { $set: { status: 'SAMPLING_CLOSED' } });
    expect((await superAdmin.post(`${SAMPLING}/${closing}/unlock`).send({ acoId: acoA, reason: 'Late correction' })).status).toBe(200);
    const edit = await adminA.put(`${SAMPLING}/${closing}/selection`).send({ add: [item(cDom, 'DOMESTIC')] });
    expect(edit.status).toBe(200);
    expect(edit.body.data.state).toMatchObject({ editable: true, lockable: true, participant: { sampling: { status: 'UNLOCKED' } } });
    expect((await adminA.post(`${SAMPLING}/${closing}/lock`)).status).toBe(200);

    await CycleModel.updateOne({ _id: closing }, { $set: { status: 'ASSESSMENT_CLOSED' } });
    expect(expectError(await superAdmin.post(`${SAMPLING}/${closing}/unlock`).send({ acoId: acoA, reason: 'Too late' }), 412, 'PRECONDITION_FAILED').message).toContain('closed');
  });
});

describe('GET /sampling/cycles/:cycleId/audit', () => {
  it('lists the participant’s sample.* entries, newest first, scoped to the operator', async () => {
    const res = await adminA.get(`${SAMPLING}/${cycleId}/audit`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const entries = res.body.data as { action: string; orgId: string; entity: string; entityId: string }[];
    expect(entries.map((e) => e.action)).toEqual([
      'sample.locked',
      'sample.selection.changed',
      'sample.unlocked',
      'sample.locked',
      'sample.selection.changed',
      'sample.selection.changed',
      'sample.selection.changed',
      'sample.selection.changed',
    ]);
    expect(entries.every((e) => e.orgId === acoA && e.entity === 'sample' && e.entityId === cycleId)).toBe(true);
    expect(res.body.meta.total).toBe(8);

    const platform = await superAdmin.get(`${SAMPLING}/${cycleId}/audit?acoId=${acoA}&action=sample.locked`);
    expect(platform.body.meta.total).toBe(2);
    const other = await adminB.get(`${SAMPLING}/${cycleId}/audit`);
    expect(other.body.meta.total).toBe(0);
    expectError(await adminB.get(`${SAMPLING}/${cycleId}/audit?acoId=${acoA}`), 404, 'NOT_FOUND');
    expectError(await superAdmin.get(`${SAMPLING}/${cycleId}/audit`), 400, 'VALIDATION');
  });
});

describe('GET /customers/:id/participation', () => {
  it('lists the cycles a customer was sampled in with the sample state', async () => {
    const res = await adminA.get(`/api/v1/customers/${cBoth}/participation`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.customer).toMatchObject({ id: cBoth, name: 'Both Ways Logistics', surveyType: 'BOTH' });
    const rows = res.body.data.cycles as { cycle: { code: string } | null; surveyType: string; state: string; submitted: boolean | null }[];
    expect(rows.map((r) => [r.cycle?.code, r.surveyType, r.state])).toEqual(
      expect.arrayContaining([
        ['SMP-BOTH', 'DOMESTIC', 'LOCKED'],
        ['SMP-BOTH', 'INTERNATIONAL', 'LOCKED'],
        ['SMP-DOM', 'DOMESTIC', 'LOCKED'],
        ['SMP-RUNNING', 'DOMESTIC', 'SELECTED'],
        ['SMP-REOPEN', 'DOMESTIC', 'LOCKED'],
      ]),
    );
    expect(rows).toHaveLength(5);
    // The assessments module is registered by the app, so the flag is read (nothing submitted yet), not null.
    expect(rows.every((r) => r.submitted === false)).toBe(true);

    const none = await adminA.get(`/api/v1/customers/${cIntl}/participation`);
    expect((none.body.data.cycles as { cycle: { code: string } }[]).map((r) => r.cycle.code)).toEqual(['SMP-BOTH']);
  });

  it('is tenant-scoped and 404 for another operator’s customer', async () => {
    expectError(await adminB.get(`/api/v1/customers/${cBoth}/participation`), 404, 'NOT_FOUND');
    expectError(await adminA.get(`/api/v1/customers/${cOther}/participation`), 404, 'NOT_FOUND');
    const platform = await superAdmin.get(`/api/v1/customers/${cOther}/participation?acoId=${acoB}`);
    expect(platform.status).toBe(200);
    expect(platform.body.data.cycles).toEqual([]);
  });
});
