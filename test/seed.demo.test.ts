// The demo dataset (`npm run seed:demo`), built twice on its own database:
// the second run creates nothing, the scored cycles carry ranks and one
// suppressed operator, the operator dashboard has figures and deltas, the
// live cycle shows an operator mid-selection, and `--reset` removes only
// what the demo tagged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { AirportModel } from '../src/modules/airports/airports.model.js';
import { RoleModel } from '../src/modules/identity/roles.model.js';
import { UserModel } from '../src/modules/identity/users.model.js';
import { OrganisationModel } from '../src/modules/organisations/organisations.model.js';
import { getScores } from '../src/modules/scoring/scoring.service.js';
import { SurveyModel } from '../src/modules/surveys/surveys.model.js';
import { runDemoSeed, type DemoSeedResult } from '../src/seed/demo/run.js';
import { countDemoData, resetDemoData } from '../src/seed/demo/tag.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';

// Its own database: the dataset is large and slow to build, and must not share
// a reset with the other files. The name derives from the suite's database
// (`csq_test` → `csq_demo_test`, `csq_b_test` → `csq_b_demo_test`), so two
// suites running on different databases never share this one either.
function demoDatabase(uri: string): string {
  const match = /^(.*\/)([^/?]*)(\?.*)?$/.exec(uri);
  if (!match) return uri;
  const [, prefix = '', db = '', query = ''] = match;
  const base = db.endsWith('_demo_test') ? db.slice(0, -'_demo_test'.length) : db.endsWith('_test') ? db.slice(0, -'_test'.length) : 'csq';
  return `${prefix}${base}_demo_test${query}`;
}
process.env['MONGO_URI'] = demoDatabase(process.env['MONGO_URI'] ?? 'mongodb://127.0.0.1:27017/csq_test?replicaSet=rs0');

const SUPER_ADMIN = { email: 'demo.admin@example.in', name: 'Demo Admin' };

let t: TestApp;
let superAdmin: TestUser;
let first: DemoSeedResult;
let second: DemoSeedResult;

function operatorId(result: DemoSeedResult, code: string): string {
  const operator = result.operators.find((candidate) => candidate.code === code);
  if (!operator) throw new Error(`Operator ${code} missing from the seed result`);
  return operator.id;
}

function cycleOf(result: DemoSeedResult, code: string): DemoSeedResult['cycles'][number] {
  const cycle = result.cycles.find((candidate) => candidate.code === code);
  if (!cycle) throw new Error(`Cycle ${code} missing from the seed result`);
  return cycle;
}

beforeAll(async () => {
  t = await createTestApp();
  first = await runDemoSeed({ superAdmin: SUPER_ADMIN });
  second = await runDemoSeed({ superAdmin: SUPER_ADMIN });
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
}, 900_000);
afterAll(() => t.close());

describe('seed:demo', () => {
  it('builds the dataset once: the second run keeps everything and creates nothing', () => {
    expect(first.cycles.map((cycle) => [cycle.code, cycle.status, cycle.fresh])).toEqual([
      ['CSQ-2025-H2', 'SCORED', true],
      ['CSQ-2026-H1', 'SCORED', true],
      ['CSQ-2026-H2', 'SAMPLING_OPEN', true],
    ]);
    expect(first.operators).toHaveLength(13);
    expect(first.customers.created).toBe(first.customers.planned);
    expect(first.onboarding.registrationsCreated).toBe(2);
    expect(first.onboarding.unusedLinkUrl).toContain('/register/');

    expect(second.cycles.every((cycle) => !cycle.fresh)).toBe(true);
    expect(second.customers.created).toBe(0);
    expect(second.users.created).toBe(0);
    expect(second.onboarding).toEqual({ unusedLinkUrl: null, registrationsCreated: 0 });
    expect(second.counts).toEqual(first.counts);
    expect(first.counts['organisations']).toBe(13);
    expect(first.counts['cycles']).toBe(3);
    expect(first.counts['registrations']).toBe(2);
    expect(first.counts['onboarding_links']).toBe(3);
  });

  it('scores both past cycles with ranks, and suppresses the operator with two responses', async () => {
    const h1 = cycleOf(first, 'CSQ-2026-H1');
    const leader = await getScores(h1.id, operatorId(first, 'BLR-GCT'), 'DOMESTIC');
    const overall = leader.rows.find((row) => row.level === 'OVERALL');
    expect(overall?.rank).toBe(1);
    expect(overall?.rankOf).toBe(12);
    expect(overall?.customer.mean).toBeGreaterThan(4);
    expect(overall?.previous?.mean).toBeLessThan(overall?.customer.mean ?? 0);
    expect(overall?.delta).toBeGreaterThan(0);
    expect(leader.provisional).toBe(false);
    expect(leader.rows.filter((row) => row.level === 'QUESTION').length).toBeGreaterThan(20);

    const delhi = await getScores(h1.id, operatorId(first, 'DEL-CTS'), 'INTERNATIONAL');
    expect(delhi.rows.find((row) => row.level === 'OVERALL')?.rank).toBeLessThanOrEqual(2);

    const suppressed = await getScores(h1.id, operatorId(first, 'GOI-KCT'), 'DOMESTIC');
    const goa = suppressed.rows.find((row) => row.level === 'OVERALL');
    expect(goa?.suppressed).toBe('INSUFFICIENT_RESPONSES');
    expect(goa?.customer.n).toBe(2);
    expect(goa?.rank).toBeNull();

    const previous = cycleOf(first, 'CSQ-2025-H2');
    const earlier = await getScores(previous.id, operatorId(first, 'GOI-KCT'), 'DOMESTIC');
    expect(earlier.rows.find((row) => row.level === 'OVERALL')?.suppressed).toBeUndefined();
  });

  it('serves the operator dashboard with non-null figures and deltas against the previous cycle', async () => {
    const acoId = operatorId(first, 'DEL-CTS');
    const res = await superAdmin.get(`/api/v1/reports/operator/${acoId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const report = res.body.data;
    expect(report.cycle.code).toBe('CSQ-2026-H1');
    expect(report.provisional).toBe(false);
    expect(report.overall.customer.mean).toBeGreaterThan(3.5);
    expect(report.overall.customer.n).toBeGreaterThan(20);
    expect(report.overall.self.mean).not.toBeNull();
    expect(report.overall.rank).toBeLessThanOrEqual(2);
    expect(report.comparison.previous).toMatchObject({ cycleName: 'CSQ 2025 H2' });
    expect(report.comparison.previous.customer).toBeLessThan(report.comparison.current.customer);
    expect(report.categories).toHaveLength(4);
    for (const category of report.categories) {
      expect(category.customer.mean).not.toBeNull();
      expect(category.previous).not.toBeNull();
      expect(category.delta).not.toBeNull();
    }
    expect(report.byStakeholder.FF.mean).not.toBeNull();
    expect(report.byStakeholder.CB.mean).not.toBeNull();
    expect(report.assessorStats.total).toBeGreaterThanOrEqual(60);
    expect(report.assessorStats.completed).toBeGreaterThan(40);
    expect(report.assessorStats.inProgress).toBeGreaterThan(0);
    expect(report.feedbackDistribution.find((bucket: { label: string }) => bucket.label === 'Excellent').count).toBeGreaterThan(0);
    expect(report.nationalTable).toHaveLength(10);
    expect(report.nationalTable[0].rank).toBe(1);
  });

  it('shows the live cycle mid-selection: 37 / 50 for Mumbai, two locked, one not started', async () => {
    const live = cycleOf(first, 'CSQ-2026-H2');
    const acoId = operatorId(first, 'BOM-MACH');
    const current = await superAdmin.get(`/api/v1/cycles/current?acoId=${acoId}`);
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.body.data).toHaveLength(1);
    expect(current.body.data[0]).toMatchObject({
      cycle: { id: live.id, code: 'CSQ-2026-H2', status: 'SAMPLING_OPEN', minSampleSize: 50 },
      participant: { requiredSampleSize: 50, sampling: { status: 'IN_PROGRESS', selectedCount: 37 } },
      nextDeadline: { kind: 'SAMPLING_CLOSES' },
    });

    const selection = await superAdmin.get(`/api/v1/sampling/cycles/${live.id}?acoId=${acoId}`);
    expect(selection.status, JSON.stringify(selection.body)).toBe(200);
    expect(selection.body.data).toMatchObject({ progress: '37 / 50', selectedCount: 37, required: 50, editable: true, lockable: false, reason: 'BELOW_MINIMUM' });

    const detail = await superAdmin.get(`/api/v1/cycles/${live.id}`);
    expect(detail.status).toBe(200);
    const statuses = detail.body.data.participantList.map((row: { sampling: { status: string } }) => row.sampling.status);
    expect(statuses.filter((status: string) => status === 'LOCKED')).toHaveLength(2);
    expect(statuses.filter((status: string) => status === 'NOT_STARTED')).toHaveLength(1);
    expect(detail.body.data.progress.locked).toBe(2);

    const reminders = await superAdmin.get(`/api/v1/notifications?cycleId=${live.id}&template=sampling-reminder`);
    expect(reminders.status).toBe(200);
    expect(reminders.body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('keeps two registrations waiting for review, one of them over the airport total', async () => {
    const list = await superAdmin.get('/api/v1/registrations?status=SUBMITTED');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.meta.total).toBe(2);
    const bengaluru = list.body.data.find((row: { airport: { iata: string } }) => row.airport.iata === 'BLR');
    const detail = await superAdmin.get(`/api/v1/registrations/${bengaluru.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.marketShare).toMatchObject({ total: 100, projectedTotal: 125 });
  });

  it('reset removes every tagged document and nothing else', async () => {
    const removed = await resetDemoData();
    expect(Object.values(removed).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(1000);
    const counts = await countDemoData();
    expect(Object.values(counts).every((count) => count === 0)).toBe(true);

    expect(await AirportModel.countDocuments({ active: true })).toBe(14);
    expect(await RoleModel.countDocuments({ system: true })).toBe(6);
    expect(await SurveyModel.countDocuments({ status: 'PUBLISHED' })).toBe(2);
    expect(await OrganisationModel.countDocuments({ type: 'ACO' })).toBe(0);
    expect(await OrganisationModel.countDocuments({ code: 'ACFI' })).toBe(1);
    const kept = await UserModel.findOne({ email: SUPER_ADMIN.email }).lean();
    expect(idString(kept!._id)).toBeTruthy();
  });
});
