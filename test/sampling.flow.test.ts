// The sampling part of the flow: ACFI publishes a cycle through the real
// cycles module, the operator builds its directory, selects and locks, the
// cycles module sees the lock (participants, monitoring, the cycle strip),
// ACFI unlocks with a reason and the operator swaps and re-locks. The
// contract functions (`getSelection`, `lock`, `unlock`) are driven directly.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { scopeForOrg, type RequestContext } from '../src/core/auth/session.js';
import { idString } from '../src/core/ids.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import { getSelection, lock, unlock } from '../src/modules/sampling/sampling.service.js';
import { seedSurveys } from '../src/seed/surveys.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, expectError } from './helpers/fixtures.js';

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

/** 'YYYY-MM-DDTHH:mm' in the default cycle time zone, `days` from today. */
function wall(days: number, time: string): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() + days * DAY),
  );
  return `${date}T${time}`;
}

/** The context a request would carry for this user, for service-level calls. */
function contextOf(as: TestUser): RequestContext {
  const org = { id: idString(as.org._id), type: as.org.type, airportId: as.org.airportId ? idString(as.org.airportId) : null };
  return {
    user: { id: idString(as.user._id), email: as.user.email, name: as.user.name, status: as.user.status },
    org: { ...org, code: as.org.code, name: as.org.name },
    role: { id: idString(as.role._id), code: as.role.code, scope: as.role.scope },
    tasks: new Set<string>(),
    scope: scopeForOrg(org),
    requestId: `test-${as.role.code}`,
    ip: '127.0.0.1',
  };
}

let t: TestApp;
let superAdmin: TestUser;
let acoAdmin: TestUser;
let acoId: string;
let airportId: string;
let cycleId: string;
const customers: Record<'both' | 'domestic' | 'international', string> = { both: '', domestic: '', international: '' };

const item = (customerId: string, surveyType: 'DOMESTIC' | 'INTERNATIONAL') => ({ customerId, surveyType });

beforeAll(async () => {
  t = await createTestApp();
  await seedSurveys();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'ACFI Admin' });
  acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'FLOW-SMP', airportIata: 'HYD', name: 'Meera Nair' });
  acoId = idString(acoAdmin.org._id);
  airportId = await airportIdByIata('HYD');
  const share = await superAdmin.put(`/api/v1/airports/${airportId}/market-share`).send({ entries: [{ acoId, sharePct: 100 }] });
  expect(share.status, JSON.stringify(share.body)).toBe(200);
});
afterAll(() => t.close());

describe('publish → sample → lock → unlock → re-lock', () => {
  it('ACFI publishes a cycle whose sampling window is running; the operator sees an empty, editable selection', async () => {
    const created = await superAdmin.post('/api/v1/cycles').send({
      name: 'Flow Both 2026',
      code: 'FLOW-SMP-1',
      type: 'BOTH',
      sampling: { start: wall(-1, '00:00'), end: wall(10, '23:59') },
      assessment: { start: wall(11, '00:00'), end: wall(40, '23:59') },
      minSampleSize: 2,
      participatingAirportIds: [airportId],
      participatingAcoIds: [acoId],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    cycleId = created.body.data.id as string;

    const published = await superAdmin.post(`/api/v1/cycles/${cycleId}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.data.status).toBe('SAMPLING_OPEN');
    expect(published.body.data.participantList).toHaveLength(1);
    expect(published.body.data.participantList[0]).toMatchObject({ acoId, requiredSampleSize: 2, sampling: { status: 'NOT_STARTED', selectedCount: 0 } });

    const state = await acoAdmin.get(`${SAMPLING}/${cycleId}`);
    expect(state.status, JSON.stringify(state.body)).toBe(200);
    expect(state.body.data).toMatchObject({
      cycle: { id: cycleId, code: 'FLOW-SMP-1', status: 'SAMPLING_OPEN' },
      participant: { surveyTypes: ['DOMESTIC', 'INTERNATIONAL'], requiredSampleSize: 2 },
      required: 2,
      selectedCount: 0,
      eligibleCount: 0,
      editable: true,
      lockable: false,
      reason: 'NOTHING_SELECTED',
      selection: [],
    });
  });

  it('the operator builds its directory, selects two entries and locks through the contract function', async () => {
    const create = async (body: Record<string, unknown>): Promise<string> => {
      const res = await acoAdmin.post('/api/v1/customers').send({ contactPerson: 'Contact', phone: '+91 98765 43210', ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.data.id as string;
    };
    customers.both = await create({ name: 'Deccan Freight', email: 'ops@deccan.test', type: 'FF', surveyType: 'BOTH' });
    customers.domestic = await create({ name: 'Hyderabad Brokers', email: 'cha@hydbrokers.test', type: 'CB', surveyType: 'DOMESTIC' });
    customers.international = await create({ name: 'Global Forwarders', email: 'intl@global.test', type: 'FF', surveyType: 'INTERNATIONAL' });

    const before = await getSelection(cycleId, acoId);
    expect(before).toMatchObject({ eligibleCount: 4, shortfallRule: null, remaining: 2, progress: '0 / 2' });

    const selected = await acoAdmin.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [item(customers.both, 'DOMESTIC'), item(customers.domestic, 'DOMESTIC')] });
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    expect(selected.body.data).toMatchObject({ rejected: [], state: { selectedCount: 2, lockable: true, reason: null, progress: '2 / 2', progressPct: 100 } });

    const locked = await lock(contextOf(acoAdmin), cycleId);
    expect(locked).toMatchObject({
      lockable: false,
      reason: 'ALREADY_LOCKED',
      editable: false,
      participant: { sampling: { status: 'LOCKED', selectedCount: 2, lockedBy: idString(acoAdmin.user._id) } },
    });
    expect(locked.selection.map((row) => [row.customer?.name, row.surveyType, row.state])).toEqual([
      ['Deccan Freight', 'DOMESTIC', 'LOCKED'],
      ['Hyderabad Brokers', 'DOMESTIC', 'LOCKED'],
    ]);
    const mail = await NotificationModel.findOne({ template: 'sample-locked' }).lean();
    expect(mail).toMatchObject({ to: acoAdmin.user.email, status: 'SENT', subject: 'Sample locked for Flow Both 2026' });
    expect(mail!.body).toContain('locked by Meera Nair');
  });

  it('the cycles module sees the lock: participants, monitoring, the cycle strip and progress', async () => {
    const participants = await superAdmin.get(`/api/v1/cycles/${cycleId}/participants`);
    expect(participants.status, JSON.stringify(participants.body)).toBe(200);
    expect(participants.body.data).toHaveLength(1);
    expect(participants.body.data[0]).toMatchObject({ acoId, sampling: { status: 'LOCKED', selectedCount: 2, unlockedAt: null } });
    expect(participants.body.data[0].sampling.lockedAt).toBeTruthy();

    const monitoring = await superAdmin.get(`/api/v1/cycles/${cycleId}/monitoring`);
    expect(monitoring.status, JSON.stringify(monitoring.body)).toBe(200);
    expect(monitoring.body.data.sampling).toMatchObject({ operators: 1, sampleRequired: 2, sampleLocked: 2, lockedOperators: 1 });

    // The seeded matrix gives ACO_ADMIN no `cycles.view`; PLATFORM reads the operator's strip with ?acoId=.
    const current = await superAdmin.get(`/api/v1/cycles/current?acoId=${acoId}`);
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.body.data).toHaveLength(1);
    expect(current.body.data[0]).toMatchObject({ cycle: { id: cycleId, progress: { locked: 1 } }, participant: { sampling: { status: 'LOCKED' } } });
  });

  it('only a PLATFORM context may unlock; then the operator swaps an entry and re-locks', async () => {
    await expect(unlock(contextOf(acoAdmin), cycleId, acoId, 'Operator cannot unlock itself')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const unlocked = await unlock(contextOf(superAdmin), cycleId, acoId, 'Wrong broker sampled');
    expect(unlocked).toMatchObject({
      editable: true,
      lockable: true,
      participant: { sampling: { status: 'UNLOCKED', selectedCount: 2, unlockedBy: idString(superAdmin.user._id), unlockReason: 'Wrong broker sampled' } },
    });
    expect(unlocked.selection.every((row) => row.state === 'SELECTED')).toBe(true);
    expect(await NotificationModel.countDocuments({ template: 'sample-unlocked', to: acoAdmin.user.email })).toBe(1);

    const swap = await acoAdmin
      .put(`${SAMPLING}/${cycleId}/selection`)
      .send({ remove: [item(customers.domestic, 'DOMESTIC')], add: [item(customers.international, 'INTERNATIONAL')] });
    expect(swap.status, JSON.stringify(swap.body)).toBe(200);
    expect(swap.body.data.state).toMatchObject({ selectedCount: 2, lockable: true, participant: { sampling: { status: 'UNLOCKED' } } });

    const relocked = await acoAdmin.post(`${SAMPLING}/${cycleId}/lock`);
    expect(relocked.status, JSON.stringify(relocked.body)).toBe(200);
    expect(relocked.body.data.participant.sampling).toMatchObject({ status: 'LOCKED', selectedCount: 2 });
    expect((relocked.body.data.selection as { customerId: string; state: string }[]).map((row) => [row.customerId, row.state])).toEqual([
      [customers.both, 'LOCKED'],
      [customers.international, 'LOCKED'],
    ]);
    expectError(await acoAdmin.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [item(customers.domestic, 'DOMESTIC')] }), 412, 'PRECONDITION_FAILED');

    const audit = await acoAdmin.get(`${SAMPLING}/${cycleId}/audit`);
    expect((audit.body.data as { action: string }[]).map((entry) => entry.action)).toEqual([
      'sample.locked',
      'sample.selection.changed',
      'sample.unlocked',
      'sample.locked',
      'sample.selection.changed',
    ]);
  });

  it('a customer’s participation shows the cycle, its sample state and that nothing was submitted yet', async () => {
    const both = await acoAdmin.get(`/api/v1/customers/${customers.both}/participation`);
    expect(both.status, JSON.stringify(both.body)).toBe(200);
    expect(both.body.data.cycles).toEqual([
      expect.objectContaining({ cycleId, cycle: expect.objectContaining({ code: 'FLOW-SMP-1', status: 'SAMPLING_OPEN' }), surveyType: 'DOMESTIC', state: 'LOCKED', submitted: false }),
    ]);
    const removed = await acoAdmin.get(`/api/v1/customers/${customers.domestic}/participation`);
    expect(removed.body.data.cycles).toEqual([]);
  });
});
