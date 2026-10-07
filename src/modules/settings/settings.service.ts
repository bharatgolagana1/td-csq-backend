import type { ClientSession } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';
import { audit } from '../audit/audit.service.js';

import { SettingsModel, type SettingsDoc } from './settings.model.js';
import type { SettingsDto, SettingsPatch } from './settings.schemas.js';

/** ARCHITECTURE §5 defaults; the seed and `ensureSettings()` insert them once. */
export const DEFAULT_SETTINGS = {
  key: 'global' as const,
  scoring: { minResponses: 3, weightingMode: 'EQUAL' as const },
  defaults: {
    samplingDays: 10,
    assessmentDays: 30,
    reminders: { sampling: { count: 3, everyDays: 3 }, assessment: { count: 10, everyDays: 2 } },
    tz: 'Asia/Kolkata',
  },
  branding: { orgName: 'Air Cargo Forum India' },
  revealAssessorIdentity: false,
  rbacVersion: 1,
};

function toDto(doc: SettingsDoc): SettingsDto {
  return {
    scoring: { minResponses: doc.scoring.minResponses, weightingMode: doc.scoring.weightingMode },
    defaults: {
      samplingDays: doc.defaults.samplingDays,
      assessmentDays: doc.defaults.assessmentDays,
      reminders: {
        sampling: { ...doc.defaults.reminders.sampling },
        assessment: { ...doc.defaults.reminders.assessment },
      },
      tz: doc.defaults.tz,
    },
    branding: { orgName: doc.branding.orgName },
    revealAssessorIdentity: doc.revealAssessorIdentity,
    rbacVersion: doc.rbacVersion,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Inserts the defaults when no settings document exists; safe to call
 * repeatedly. Reads first: an upsert would touch `updatedAt` (timestamps) and
 * a write outside a transaction to a document the transaction then updates
 * causes an endless WriteConflict retry loop.
 */
export async function ensureSettings(): Promise<SettingsDoc> {
  const existing = await SettingsModel.findOne({ key: 'global' }).lean<SettingsDoc | null>();
  if (existing) return existing;
  const doc = await SettingsModel.findOneAndUpdate(
    { key: 'global' },
    { $setOnInsert: DEFAULT_SETTINGS },
    { upsert: true, new: true },
  ).lean<SettingsDoc | null>();
  if (!doc) throw new AppError('INTERNAL', 'Settings could not be initialised');
  return doc;
}

export async function getSettingsDoc(): Promise<SettingsDoc> {
  const doc = await SettingsModel.findOne({ key: 'global' }).lean<SettingsDoc>();
  return doc ?? ensureSettings();
}

export async function getSettings(): Promise<SettingsDto> {
  return toDto(await getSettingsDoc());
}

export async function getRbacVersion(): Promise<number> {
  const doc = await SettingsModel.findOne({ key: 'global' }, { rbacVersion: 1 }).lean<Pick<SettingsDoc, 'rbacVersion'>>();
  return doc?.rbacVersion ?? (await ensureSettings()).rbacVersion;
}

/**
 * Called by the matrix save (inside its transaction) and by the seed. One
 * in-session upsert: `$inc` on a missing field yields 1, so a fresh document
 * gets the other defaults through `$setOnInsert` and rbacVersion 1.
 */
export async function bumpRbacVersion(session?: ClientSession): Promise<void> {
  const { rbacVersion: _ignored, ...defaults } = DEFAULT_SETTINGS;
  await SettingsModel.updateOne(
    { key: 'global' },
    { $inc: { rbacVersion: 1 }, $setOnInsert: defaults },
    { upsert: true, ...(session ? { session } : {}) },
  );
}

/** Flattens a nested partial into dotted `$set` paths so untouched fields survive. */
function dotPaths(value: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
      Object.assign(out, dotPaths(inner as Record<string, unknown>, path));
    } else {
      out[path] = inner;
    }
  }
  return out;
}

export async function updateSettings(ctx: RequestContext, patch: SettingsPatch): Promise<SettingsDto> {
  const before = await getSettingsDoc();
  const $set = dotPaths(patch);
  if (Object.keys($set).length === 0) return toDto(before);
  const after = await SettingsModel.findOneAndUpdate({ key: 'global' }, { $set }, { new: true }).lean<SettingsDoc>();
  if (!after) throw new AppError('INTERNAL', 'Settings vanished during update');
  await audit(ctx, {
    action: 'settings.updated',
    entity: 'settings',
    entityId: 'global',
    before: toDto(before),
    after: toDto(after),
  });
  return toDto(after);
}
