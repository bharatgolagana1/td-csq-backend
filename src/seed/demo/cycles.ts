// The three demo cycles and the operations that move them: creation and
// publication through the cycles service, selection and lock through the
// sampling service, status changes through `transition` with the clock
// trigger and a fake `now` (the service has no clock guard on those edges;
// the instant is only recorded). Everything a past cycle needs happens in
// the order the real clock would have done it.
import type { RequestContext } from '../../core/auth/session.js';
import { systemContext } from '../../core/auth/system.js';
import { idString, toId } from '../../core/ids.js';
import { listEligible } from '../../modules/customers/customers.service.js';
import { CycleModel } from '../../modules/cycles/cycles.model.js';
import { createCycle, getParticipant, publishCycle, setParticipantSampling, transition } from '../../modules/cycles/cycles.service.js';
import { addCalendarDays } from '../../modules/cycles/domain/derive.js';
import type { CycleStatus, WallClock } from '../../modules/cycles/domain/types.js';
import { localDateOf, toInstant } from '../../modules/cycles/domain/windows.js';
import type { SelectionStateDto } from '../../modules/sampling/sampling.schemas.js';
import { changeSelection, lock } from '../../modules/sampling/sampling.service.js';

import type { DemoOperator } from './operators.js';
import type { Rng } from './prng.js';
import { demoKey, tagDemo } from './runtime.js';

export const DEMO_TZ = 'Asia/Kolkata';

/** What one operator does in a cycle that is already over. */
export interface PastOperatorPlan {
  /** Entries selected and locked (≥ the cycle's minimum). */
  sample: number;
  /** Share of the invitations that end SUBMITTED. */
  responseRate: number;
  /** Caps the submissions (the operator suppressed by `minResponses`). */
  maxSubmissions?: number;
  /** Whether the operator submitted its self-assessment(s). */
  self: boolean;
  /** Added to the operator's quality for this cycle (negative in the older cycle so deltas show ▲). */
  qualityShift: number;
}

/** What one operator has done so far in the live cycle. */
export interface LiveOperatorPlan {
  /** Entries selected; 0 leaves the participant NOT_STARTED. */
  select: number;
  lock: boolean;
}

export interface CycleSpec {
  code: string;
  name: string;
  kind: 'PAST' | 'LIVE';
  minSampleSize: number;
  publishedAt: WallClock;
  sampling: { start: WallClock; end: WallClock };
  assessment: { start: WallClock; end: WallClock };
  past: Readonly<Record<string, PastOperatorPlan>>;
  live: Readonly<Record<string, LiveOperatorPlan>>;
}

const past = (sample: number, responseRate: number, self = true, qualityShift = 0, maxSubmissions?: number): PastOperatorPlan => ({
  sample,
  responseRate,
  self,
  qualityShift,
  ...(maxSubmissions === undefined ? {} : { maxSubmissions }),
});

const H2_2025: Readonly<Record<string, PastOperatorPlan>> = {
  'DEL-CTS': past(55, 0.82, true, -0.06),
  'DEL-NCH': past(48, 0.74, true, -0.05),
  'BOM-MACH': past(50, 0.78, true, -0.07),
  'BOM-WCL': past(42, 0.7, false, -0.04),
  'BLR-GCT': past(55, 0.84, true, -0.05),
  'BLR-SCS': past(42, 0.72, true, -0.06),
  'HYD-DCT': past(48, 0.76, true, -0.08),
  // Chennai did slightly better in 2025, so its dashboard shows one ▼ among the ▲.
  'MAA-CCG': past(42, 0.7, true, 0.04),
  'CCU-ECT': past(32, 0.72, true, -0.05),
  'COK-KCH': past(30, 0.75, true, -0.06),
  'AMD-GCS': past(31, 0.7, true, -0.04),
  'GOI-KCT': past(30, 0.7, true, -0.03),
  'PNQ-PCL': past(30, 0.72, true, -0.05),
};

const H1_2026: Readonly<Record<string, PastOperatorPlan>> = {
  'DEL-CTS': past(60, 0.82),
  'DEL-NCH': past(50, 0.74),
  'BOM-MACH': past(55, 0.78),
  'BOM-WCL': past(45, 0.7, false),
  'BLR-GCT': past(60, 0.84),
  'BLR-SCS': past(45, 0.72),
  'HYD-DCT': past(50, 0.76),
  'MAA-CCG': past(45, 0.7),
  'CCU-ECT': past(32, 0.72),
  'COK-KCH': past(30, 0.75),
  'AMD-GCS': past(32, 0.7),
  // Two responses out of thirty: below `settings.scoring.minResponses`, so its scores are suppressed.
  'GOI-KCT': past(30, 0.7, false, 0, 2),
  'PNQ-PCL': past(31, 0.72),
};

const LIVE: Readonly<Record<string, LiveOperatorPlan>> = {
  'DEL-CTS': { select: 56, lock: true },
  'DEL-NCH': { select: 44, lock: false },
  'BOM-MACH': { select: 37, lock: false },
  'BOM-WCL': { select: 21, lock: false },
  'BLR-GCT': { select: 52, lock: true },
  'BLR-SCS': { select: 30, lock: false },
  'HYD-DCT': { select: 48, lock: false },
  'MAA-CCG': { select: 12, lock: false },
  'CCU-ECT': { select: 25, lock: false },
  'COK-KCH': { select: 18, lock: false },
  'AMD-GCS': { select: 9, lock: false },
  'GOI-KCT': { select: 0, lock: false },
  'PNQ-PCL': { select: 31, lock: false },
};

/** The operator whose sampling reminder ACFI sends by hand in the live cycle. */
export const LIVE_REMINDER_OPERATOR = 'MAA-CCG';

/**
 * Two scored cycles on fixed calendar dates and one live cycle anchored on
 * today: sampling opened four days ago, the assessment opens in ten days.
 */
export function cycleSpecs(now: Date): CycleSpec[] {
  const today = localDateOf(now, DEMO_TZ);
  const day = (offset: number, time = '00:00'): WallClock => `${addCalendarDays(today, offset)}T${time}`;
  return [
    {
      code: 'CSQ-2025-H2',
      name: 'CSQ 2025 H2',
      kind: 'PAST',
      minSampleSize: 30,
      publishedAt: '2025-09-30T10:00',
      sampling: { start: '2025-10-01T00:00', end: '2025-10-11T00:00' },
      assessment: { start: '2025-10-11T00:00', end: '2025-11-10T00:00' },
      past: H2_2025,
      live: {},
    },
    {
      code: 'CSQ-2026-H1',
      name: 'CSQ 2026 H1',
      kind: 'PAST',
      minSampleSize: 30,
      publishedAt: '2026-03-31T10:00',
      sampling: { start: '2026-04-01T00:00', end: '2026-04-11T00:00' },
      assessment: { start: '2026-04-11T00:00', end: '2026-05-11T00:00' },
      past: H1_2026,
      live: {},
    },
    {
      code: 'CSQ-2026-H2',
      name: 'CSQ 2026 H2',
      kind: 'LIVE',
      minSampleSize: 50,
      publishedAt: day(-5, '10:00'),
      sampling: { start: day(-4), end: day(10) },
      assessment: { start: day(10), end: day(40) },
      past: {},
      live: LIVE,
    },
  ];
}

export function instant(wall: WallClock): Date {
  return toInstant({ wall, tz: DEMO_TZ });
}

export interface EnsuredCycle {
  id: string;
  /** True when this run created it and must build its contents. */
  fresh: boolean;
}

const STAGE_COMPLETE = 'COMPLETE';

/**
 * Finds the demo cycle, or creates it as a DRAFT through the service,
 * publishes it the day before sampling opens (status PUBLISHED, shares
 * snapshotted, participants created, admins mailed) and lets the "clock"
 * open sampling at the window start. A cycle an earlier run left half-built
 * cannot be resumed; the message says to run with `--reset`.
 */
export async function ensureCycle(ctx: RequestContext, spec: CycleSpec, operators: readonly DemoOperator[]): Promise<EnsuredCycle> {
  const key = demoKey('cycle', spec.code);
  const existing = await CycleModel.collection.findOne({ demoKey: key }, { projection: { _id: 1, demoStage: 1 } });
  if (existing) {
    if (existing['demoStage'] !== STAGE_COMPLETE) {
      throw new Error(`Demo cycle ${spec.code} exists but an earlier run did not finish it; run npm run seed:demo -- --reset`);
    }
    return { id: idString(existing._id), fresh: false };
  }
  const airportIds = [...new Set(operators.map((operator) => idString(operator.airport._id)))];
  const created = await createCycle(ctx, {
    name: spec.name,
    code: spec.code,
    type: 'BOTH',
    tz: DEMO_TZ,
    sampling: spec.sampling,
    assessment: spec.assessment,
    minSampleSize: spec.minSampleSize,
    participatingAirportIds: airportIds,
    participatingAcoIds: operators.map((operator) => idString(operator.org._id)),
  });
  await tagDemo(CycleModel, created.id, key);
  await publishCycle(ctx, created.id, instant(spec.publishedAt));
  await clockTransition(created.id, 'SAMPLING_OPEN', 'SAMPLING_START', instant(spec.sampling.start));
  return { id: created.id, fresh: true };
}

/** Recorded on the cycle once every step of its build is done. */
export async function markCycleComplete(cycleId: string): Promise<void> {
  await CycleModel.collection.updateOne({ _id: toId(cycleId) }, { $set: { demoStage: STAGE_COMPLETE } });
}

/** A status change the scheduler would have made at `at`: the CLOCK trigger takes the AUTO edge and records the instant. */
export async function clockTransition(cycleId: string, to: CycleStatus, trigger: string, at: Date): Promise<void> {
  await transition(systemContext('seed:demo clock'), cycleId, to, `CLOCK: ${trigger} at ${at.toISOString()}`, { trigger: 'CLOCK', now: at });
}

/** Adds `count` eligible (customer, surveyType) entries to the operator's selection, chosen from its own stream. */
export async function selectEntries(acoCtx: RequestContext, cycleId: string, operator: DemoOperator, count: number, rng: Rng): Promise<SelectionStateDto> {
  const acoId = idString(operator.org._id);
  const participant = await getParticipant(cycleId, acoId);
  if (!participant) throw new Error(`${operator.spec.code} is not a participant of cycle ${cycleId}`);
  const entries = await listEligible(acoId, 'BOTH', participant.surveyTypes);
  if (entries.length < count && entries.length < participant.requiredSampleSize) {
    throw new Error(`${operator.spec.code} has ${entries.length} eligible entries, fewer than the ${count} to select and the ${participant.requiredSampleSize} required`);
  }
  const chosen = rng.sample(entries, count).map((entry) => ({ customerId: entry.customer.id, surveyType: entry.surveyType }));
  const result = await changeSelection(acoCtx, cycleId, { add: chosen, remove: [] });
  if (result.rejected.length > 0) throw new Error(`${operator.spec.code}: ${result.rejected.length} selection entries rejected`);
  return result.state;
}

/** Locks through the sampling service (invitations, mail, audit), then records when it happened in the story. */
export async function lockSample(acoCtx: RequestContext, cycleId: string, operator: DemoOperator, lockedAt: Date): Promise<void> {
  await lock(acoCtx, cycleId);
  await setParticipantSampling(cycleId, idString(operator.org._id), { lockedAt });
}
