import { isOpen, validateOrdering, type CycleWindows } from '@csq/core';
import { TenantRepo } from '../../kernel/tenancy.js';
import { fail, notFound } from '../../kernel/errors.js';
import { appendAudit } from './sampling.audit.js';
import { isDuplicateKey } from './sampling.db.js';
import {
  CyclePolicyModel,
  SamplingSettingsModel,
  type CyclePolicyDoc,
  type SamplingSettingsDoc,
} from './sampling.models.js';
import type {
  CyclePolicyBody,
  CyclePolicyView,
  SamplingSettingsView,
} from './sampling.contracts.js';

/**
 * The sampling module does not own cycles. It owns the two sampling facing
 * facts of one: the windows a lock is allowed inside, and the minimum the gate
 * is measured against.
 *
 * They live in a collection here, written through an explicit endpoint, rather
 * than being read out of the cycles module's documents. Reaching into another
 * module's collection couples two schemas that are being built in parallel and
 * gives neither owner a way to know the other is reading. When the cycles
 * module lands, it writes this row on publish; the seam stays exactly where it
 * is and nothing in this module has to change.
 */

const settings = new TenantRepo<SamplingSettingsDoc>(SamplingSettingsModel);
const policies = new TenantRepo<CyclePolicyDoc>(CyclePolicyModel);

/** Created on first read, so an organisation that has never opened the screen still has settings. */
export async function loadSamplingSettings(): Promise<SamplingSettingsDoc> {
  const existing = await settings.findOne({}).lean().exec();
  if (existing) return existing;

  try {
    const created = await settings.create({});
    return created.toObject();
  } catch (error) {
    // two first requests raced; the unique index on orgId decided the winner
    if (!isDuplicateKey(error)) throw error;
    const raced = await settings.findOne({}).lean().exec();
    if (!raced) throw error;
    return raced;
  }
}

function toSettingsView(doc: SamplingSettingsDoc): SamplingSettingsView {
  return {
    approvalMode: doc.approvalMode,
    operatorDomains: [...doc.operatorDomains],
    freeMailDomains: [...doc.freeMailDomains],
    burstWindowMinutes: doc.burstWindowMinutes,
    defaultDialCode: doc.defaultDialCode,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function readSamplingSettings(): Promise<SamplingSettingsView> {
  return toSettingsView(await loadSamplingSettings());
}

export async function patchSamplingSettings(
  patch: Partial<Pick<SamplingSettingsDoc, 'approvalMode' | 'operatorDomains' | 'freeMailDomains' | 'burstWindowMinutes' | 'defaultDialCode'>>,
): Promise<SamplingSettingsView> {
  await loadSamplingSettings();

  const updated = await settings.findOneAndUpdate({}, { $set: { ...patch } }).lean().exec();
  if (!updated) throw notFound('No sampling settings for this organisation');

  await appendAudit([
    {
      action: 'SETTINGS_UPDATED',
      subjectType: 'SETTINGS',
      subjectId: updated._id,
      detail: { fields: Object.keys(patch).sort().join(',') },
    },
  ]);
  return toSettingsView(updated);
}

/**
 * The instant and the wall time have to agree. An administrator types "midnight
 * on the 12th" in one zone and a client resolves it; if the two disagree the
 * cycle opens at the wrong hour, and after invitations have gone out that is
 * not recoverable. Node carries full ICU, so the check costs nothing.
 */
function wallTimeIn(utc: Date, tz: string): string {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = format.formatToParts(utc);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}

const BOUNDARY_NAMES = ['samplingOpens', 'samplingCloses', 'assessmentOpens', 'assessmentCloses'] as const;

function checkBoundaries(body: CyclePolicyBody): void {
  const fields: Array<{ path: string; message: string }> = [];

  for (const name of BOUNDARY_NAMES) {
    const boundary = body[name];
    let resolved: string;
    try {
      resolved = wallTimeIn(boundary.utc, boundary.tz);
    } catch {
      fields.push({ path: `${name}.tz`, message: `${boundary.tz} is not a time zone this server knows` });
      continue;
    }
    if (resolved !== boundary.wall) {
      fields.push({
        path: `${name}.utc`,
        message: `resolves to ${resolved} in ${boundary.tz}, not ${boundary.wall}`,
      });
    }
  }
  if (fields.length > 0) throw fail('VALIDATION_FAILED', 'Cycle boundaries do not agree', fields);

  const problems = validateOrdering(toWindows(body));
  if (problems.length > 0) {
    throw fail(
      'VALIDATION_FAILED',
      'Cycle windows are out of order',
      problems.map((problem) => ({ path: 'windows', message: problem })),
    );
  }
}

function toWindows(source: CyclePolicyBody | CyclePolicyDoc): CycleWindows {
  return {
    samplingOpens: source.samplingOpens,
    samplingCloses: source.samplingCloses,
    assessmentOpens: source.assessmentOpens,
    assessmentCloses: source.assessmentCloses,
  };
}

export async function putCyclePolicy(cycleId: string, body: CyclePolicyBody): Promise<CyclePolicyView> {
  checkBoundaries(body);

  const saved = await policies
    .findOneAndUpdate({ cycleId }, { $set: { ...body, cycleId } }, { upsert: true })
    .lean()
    .exec();
  if (!saved) throw fail('INTERNAL', 'The cycle policy did not save');

  await appendAudit([
    {
      action: 'CYCLE_POLICY_SET',
      subjectType: 'CYCLE',
      subjectId: cycleId,
      detail: { minimumSamplingSize: body.minimumSamplingSize, samplingCloses: body.samplingCloses.wall },
    },
  ]);
  return toPolicyView(saved, new Date());
}

export async function loadCyclePolicy(cycleId: string): Promise<CyclePolicyDoc> {
  const policy = await policies.findOne({ cycleId }).lean().exec();
  if (!policy) throw notFound('No sampling policy for this cycle');
  return policy;
}

export function toPolicyView(doc: CyclePolicyDoc, now: Date): CyclePolicyView {
  const windows = toWindows(doc);
  return {
    cycleId: doc.cycleId,
    minimumSamplingSize: doc.minimumSamplingSize,
    samplingOpens: { ...doc.samplingOpens },
    samplingCloses: { ...doc.samplingCloses },
    assessmentOpens: { ...doc.assessmentOpens },
    assessmentCloses: { ...doc.assessmentCloses },
    samplingOpen: isOpen(windows, 'SAMPLING', now),
    assessmentOpen: isOpen(windows, 'ASSESSMENT', now),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function readCyclePolicy(cycleId: string, now: Date): Promise<CyclePolicyView> {
  return toPolicyView(await loadCyclePolicy(cycleId), now);
}

export function isSamplingOpen(policy: CyclePolicyDoc, now: Date): boolean {
  return isOpen(toWindows(policy), 'SAMPLING', now);
}

/**
 * The minimum the gate is measured against. The settings module owns an
 * organisation level override that may only raise this number; wiring it in is
 * one line here once the two modules stop being built in parallel, and it
 * belongs here rather than at the three call sites that ask for a minimum.
 */
export function effectiveMinimum(policy: CyclePolicyDoc): number {
  return policy.minimumSamplingSize;
}
