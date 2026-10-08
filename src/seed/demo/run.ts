// `npm run seed:demo`: the illustrative ACFI dataset, built through the
// modules' services in the order the product would have produced it —
// operators and shares, users, directories, two cycles replayed from
// publication to scoring, one live cycle mid-sampling, and an onboarding
// queue. Idempotent: every record carries a stable `demoKey`, a second run
// finds and keeps what the first made, `--reset` removes only tagged data.
import { loadEnv } from '../../config/env.js';
import type { RequestContext } from '../../core/auth/session.js';
import { systemContext } from '../../core/auth/system.js';
import { idString } from '../../core/ids.js';
import { getCycle } from '../../modules/cycles/cycles.service.js';
import { sendRemindersNow } from '../../modules/cycles/reminders.service.js';
import { activateCycle, expireDue } from '../../modules/invitations/invitations.service.js';
import { latestPublishedVersionIds } from '../../modules/surveys/surveys.service.js';
import type { SuperAdminInput } from '../super-admin.js';
import { seedSurveys } from '../surveys.js';

import { backdateCycle } from './backdate.js';
import { ensureCustomers } from './customers.js';
import { clockTransition, cycleSpecs, ensureCycle, instant, LIVE_REMINDER_OPERATOR, lockSample, markCycleComplete, selectEntries, type CycleSpec } from './cycles.js';
import { ensureMarketShares, ensureOperators, type DemoOperator } from './operators.js';
import { Rng } from './prng.js';
import { ensureOnboarding, type OnboardingResult } from './registrations.js';
import { FormCache, newBackdates, respondToInvitations, submitSelfAssessments, type RatingProfile, type ResponseCycle } from './responses.js';
import { prepareDemoRuntime } from './runtime.js';
import { countDemoData, resetDemoData, tagDemoData } from './tag.js';
import { ensureDemoUsers, operatorContext, resolvePlatformActor, type PlatformActor } from './users.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface DemoSeedOptions {
  /** `--super-admin email=… name=…`: created or kept, never tagged. */
  superAdmin?: SuperAdminInput | null;
  /** Delete every tagged document first. */
  reset?: boolean;
  /** The seed's idea of "today" (the live cycle is anchored on it). */
  now?: Date;
  log?: (line: string) => void;
}

export interface DemoCycleSummary {
  id: string;
  code: string;
  status: string;
  fresh: boolean;
}

export interface DemoSeedResult {
  durationMs: number;
  actor: { email: string; name: string };
  operators: { id: string; code: string; name: string; iata: string }[];
  users: { created: number; kept: number };
  customers: { planned: number; created: number };
  cycles: DemoCycleSummary[];
  onboarding: OnboardingResult;
  /** Tagged documents per collection. */
  counts: Record<string, number>;
  reset: Record<string, number> | null;
}

interface Build {
  actor: PlatformActor;
  operators: DemoOperator[];
  contexts: Map<string, RequestContext>;
  rng: Rng;
  log: (line: string) => void;
}

function profileOf(operator: DemoOperator, shift: number): RatingProfile {
  return { quality: Math.min(0.98, Math.max(0.02, operator.spec.quality + shift)), bias: operator.spec.bias };
}

function contextOf(build: Build, operator: DemoOperator): RequestContext {
  const ctx = build.contexts.get(operator.spec.code);
  if (!ctx) throw new Error(`No context for ${operator.spec.code}`);
  return ctx;
}

/**
 * A cycle that is over, replayed: every operator selects and locks during
 * the sampling window, the clock closes sampling, activation sends the
 * invitations at the assessment start, customers answer through the public
 * flow, operators submit their self-assessments, the clock closes the
 * assessment (scoring runs and marks the cycle SCORED), the invitations
 * left behind expire, and the timestamps the services stamped with the
 * real clock are moved into the window.
 */
async function buildPastCycle(build: Build, spec: CycleSpec, cycleId: string): Promise<void> {
  const { actor, operators, log } = build;
  const samplingStart = instant(spec.sampling.start);
  const samplingEnd = instant(spec.sampling.end);
  const assessmentStart = instant(spec.assessment.start);
  const assessmentEnd = instant(spec.assessment.end);
  const rng = build.rng.fork(`cycle:${spec.code}`);
  const lockedAtByAco = new Map<string, Date>();

  for (const operator of operators) {
    const plan = spec.past[operator.spec.code];
    if (!plan) continue;
    const opRng = rng.fork(`sample:${operator.spec.code}`);
    await selectEntries(contextOf(build, operator), cycleId, operator, plan.sample, opRng);
    const lockedAt = new Date(samplingStart.getTime() + opRng.int(1, 8) * DAY + opRng.int(9, 18) * HOUR);
    await lockSample(contextOf(build, operator), cycleId, operator, lockedAt);
    lockedAtByAco.set(idString(operator.org._id), lockedAt);
  }
  log(`  ${spec.code}: ${lockedAtByAco.size} operators selected and locked`);

  await clockTransition(cycleId, 'SAMPLING_CLOSED', 'SAMPLING_END', samplingEnd);
  // Activation first, at the story's instant; the ASSESSMENT_OPEN listener then re-runs it
  // without a `now` and finds every invitation already sent (`once` slots are taken).
  await activateCycle(cycleId, { ctx: systemContext('seed:demo activation'), now: assessmentStart });
  await clockTransition(cycleId, 'ASSESSMENT_OPEN', 'ASSESSMENT_START', assessmentStart);

  const detail = await getCycle(actor.ctx, cycleId);
  const cycle: ResponseCycle = { id: cycleId, assessmentStart, assessmentEnd, surveyVersions: detail.surveyVersions };
  const forms = new FormCache();
  const backdates = newBackdates();
  let submitted = 0;
  let invited = 0;
  for (const operator of operators) {
    const plan = spec.past[operator.spec.code];
    if (!plan) continue;
    const acoId = idString(operator.org._id);
    const profile = profileOf(operator, plan.qualityShift);
    const responses = await respondToInvitations(
      actor.ctx,
      cycle,
      acoId,
      { responseRate: plan.responseRate, maxSubmissions: plan.maxSubmissions, profile },
      rng.fork(`responses:${operator.spec.code}`),
      forms,
      backdates,
    );
    submitted += responses.submitted;
    invited += responses.invited;
    if (plan.self) {
      const participant = detail.participantList.find((row) => row.acoId === acoId);
      if (participant) await submitSelfAssessments(contextOf(build, operator), cycle, participant.surveyTypes, profile, rng.fork(`self:${operator.spec.code}`), forms, backdates);
    }
  }
  log(`  ${spec.code}: ${submitted} of ${invited} invitations submitted`);

  await clockTransition(cycleId, 'ASSESSMENT_CLOSED', 'ASSESSMENT_END', assessmentEnd);
  const scored = await getCycle(actor.ctx, cycleId);
  if (scored.status !== 'SCORED') throw new Error(`Cycle ${spec.code} is ${scored.status} after closing; scoring did not complete`);
  await expireDue(new Date(assessmentEnd.getTime() + MINUTE));
  await backdateCycle({
    ...backdates,
    cycleId,
    scoredAt: new Date(assessmentEnd.getTime() + 5 * MINUTE),
    samplingStart,
    lockedAtByAco,
    rng: rng.fork('backdate'),
  });
  log(`  ${spec.code}: scored`);
}

/** The cycle in progress: selections at various stages, two locks, one sampling reminder sent by hand. */
async function buildLiveCycle(build: Build, spec: CycleSpec, cycleId: string, now: Date): Promise<void> {
  const { actor, operators, log } = build;
  const rng = build.rng.fork(`cycle:${spec.code}`);
  let locked = 0;
  let selecting = 0;
  for (const operator of operators) {
    const plan = spec.live[operator.spec.code];
    if (!plan || plan.select === 0) continue;
    const opRng = rng.fork(`sample:${operator.spec.code}`);
    await selectEntries(contextOf(build, operator), cycleId, operator, plan.select, opRng);
    if (plan.lock) {
      await lockSample(contextOf(build, operator), cycleId, operator, new Date(now.getTime() - opRng.int(20, 60) * HOUR));
      locked += 1;
    } else {
      selecting += 1;
    }
  }
  const reminded = operators.find((operator) => operator.spec.code === LIVE_REMINDER_OPERATOR);
  if (reminded) await sendRemindersNow(actor.ctx, cycleId, { kind: 'SAMPLING', acoId: idString(reminded.org._id) }, now);
  log(`  ${spec.code}: ${locked} locked, ${selecting} selecting, ${operators.length - locked - selecting} not started`);
}

export async function runDemoSeed(options: DemoSeedOptions = {}): Promise<DemoSeedResult> {
  const startedAt = new Date();
  const now = options.now ?? startedAt;
  const log = options.log ?? (() => undefined);
  const env = loadEnv();
  const restore = prepareDemoRuntime(env);
  try {
    const reset = options.reset === true ? await resetDemoData() : null;
    if (reset) log(`Reset: removed ${Object.values(reset).reduce((sum, n) => sum + n, 0)} tagged documents`);

    await seedSurveys();
    const versions = await latestPublishedVersionIds();
    if (!versions.DOMESTIC || !versions.INTERNATIONAL) throw new Error('Both surveys must be published; run npm run seed first');

    const actor = await resolvePlatformActor(options.superAdmin ?? null);
    const operators = await ensureOperators(actor.ctx);
    const sharesWritten = await ensureMarketShares(actor.ctx, operators);
    log(`Operators: ${operators.length} (${operators.filter((operator) => operator.created).length} created), market-share sets written: ${sharesWritten}`);
    const users = await ensureDemoUsers(actor, operators);
    log(`Users: ${users.created} created, ${users.kept} kept`);

    const rng = new Rng('csq-demo-v1');
    const customers = { planned: 0, created: 0 };
    for (const operator of operators) {
      const result = await ensureCustomers(actor.ctx, operator, rng);
      customers.planned += result.planned;
      customers.created += result.created;
    }
    log(`Customers: ${customers.planned} planned, ${customers.created} created`);

    const contexts = new Map<string, RequestContext>();
    for (const operator of operators) contexts.set(operator.spec.code, await operatorContext(operator));
    const build: Build = { actor, operators, contexts, rng, log };

    const cycles: DemoCycleSummary[] = [];
    for (const spec of cycleSpecs(now)) {
      const ensured = await ensureCycle(actor.ctx, spec, operators);
      if (ensured.fresh) {
        if (spec.kind === 'PAST') await buildPastCycle(build, spec, ensured.id);
        else await buildLiveCycle(build, spec, ensured.id, now);
        await markCycleComplete(ensured.id);
      } else {
        log(`  ${spec.code}: kept`);
      }
      const detail = await getCycle(actor.ctx, ensured.id);
      cycles.push({ id: ensured.id, code: spec.code, status: detail.status, fresh: ensured.fresh });
    }

    const onboarding = await ensureOnboarding(actor.ctx);
    log(`Onboarding: ${onboarding.registrationsCreated} registrations created`);

    await tagDemoData({
      startedAt,
      orgIds: operators.map((operator) => idString(operator.org._id)),
      userIds: operators.map((operator) => idString(operator.admin._id)),
      cycleIds: cycles.map((cycle) => cycle.id),
    });
    const counts = await countDemoData();

    return {
      durationMs: Date.now() - startedAt.getTime(),
      actor: { email: actor.user.email, name: actor.user.name },
      operators: operators.map((operator) => ({ id: idString(operator.org._id), code: operator.spec.code, name: operator.spec.name, iata: operator.spec.iata })),
      users,
      customers,
      cycles,
      onboarding,
      counts,
      reset,
    };
  } finally {
    restore();
  }
}
