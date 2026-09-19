import { TenantRepo } from '../../kernel/tenancy.js';
import { conflict, fail, forbidden, fromZod } from '../../kernel/errors.js';
import {
  hasCapability,
  requireCapability,
  requireOrgId,
  requirePrincipal,
  type Principal,
} from '../../kernel/requestContext.js';
import {
  ALL_AREAS,
  LINK_AREAS,
  apiPathOf,
  areaOf,
  asAreaValue,
  defaultsOf,
  fullSchemaOf,
  patchSchemaOf,
  type AreaDefinition,
  type AreaValue,
  type GlobalAreaKey,
  type OrgAreaKey,
  type SelfAreaKey,
  type SettingsCapability,
} from './settings.areas.js';
import {
  OrgSettingsAreaModel,
  OrgSettingsAuditModel,
  PLATFORM_SUBJECT,
  PlatformSettingsAreaModel,
  UnscopedSettingsAuditModel,
  UserSettingsAreaModel,
  type OrgAreaDoc,
  type OrgAuditDoc,
} from './settings.models.js';
import { summariseLists } from './settings.lists.service.js';
import type { AreaView, AuditEntryView, CatalogueEntry, ListKind } from './settings.contracts.js';

/**
 * One engine for every area, and three stores under it.
 *
 * Reading, merging defaults, validating, the revision check and the audit row
 * are written once. What differs between a platform area, an organisation area
 * and a personal one is only where the document lives and who is allowed to
 * ask, so that is all a store decides.
 */

interface StoredArea {
  readonly value: unknown;
  readonly revision: number;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

interface AreaStore {
  read(key: string): Promise<StoredArea | null>;
  /** Null when another writer created the first version in between. */
  insertFirst(key: string, value: AreaValue, actorUserId: string | null): Promise<StoredArea | null>;
  /** Null when the revision moved under us. */
  replace(
    key: string,
    expectedRevision: number,
    value: AreaValue,
    actorUserId: string | null,
  ): Promise<StoredArea | null>;
  writeAudit(key: string, actorUserId: string | null, before: AreaValue, after: AreaValue): Promise<void>;
  history(key: string, limit: number): Promise<AuditEntryView[]>;
}

const DUPLICATE_KEY = 11000;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY
  );
}

/** Stored settings that are no longer a shape this code understands are a fault, not a 400. */
function readValue(raw: unknown, key: string): AreaValue {
  try {
    return asAreaValue(raw, key);
  } catch {
    throw fail('INTERNAL', `Stored ${key} settings are not a settings payload`);
  }
}

const orgAreas = new TenantRepo<OrgAreaDoc>(OrgSettingsAreaModel);
const orgAudits = new TenantRepo<OrgAuditDoc>(OrgSettingsAuditModel);

const orgStore: AreaStore = {
  async read(key) {
    return orgAreas.findOne({ areaKey: key }).lean().exec();
  },
  async insertFirst(key, value, actorUserId) {
    try {
      const created = await orgAreas.create({
        areaKey: key,
        value,
        revision: 1,
        updatedBy: actorUserId,
      });
      return created.toObject();
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    }
  },
  async replace(key, expectedRevision, value, actorUserId) {
    return orgAreas
      .findOneAndUpdate(
        { areaKey: key, revision: expectedRevision },
        { $set: { value, revision: expectedRevision + 1, updatedBy: actorUserId } },
      )
      .lean()
      .exec();
  },
  async writeAudit(key, actorUserId, before, after) {
    await orgAudits.create({ areaKey: key, actorUserId, before, after });
  },
  async history(key, limit) {
    const rows = await orgAudits
      .find({ areaKey: key })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return rows.map((row) => toAuditView(row._id, key, row.actorUserId, row.createdAt, row.before, row.after));
  },
};

function selfStore(userId: string): AreaStore {
  return {
    async read(key) {
      return UserSettingsAreaModel.findOne({ userId, areaKey: key }).lean().exec();
    },
    async insertFirst(key, value, actorUserId) {
      try {
        const created = await UserSettingsAreaModel.create({
          userId,
          areaKey: key,
          value,
          revision: 1,
          updatedBy: actorUserId,
        });
        return created.toObject();
      } catch (error) {
        if (isDuplicateKey(error)) return null;
        throw error;
      }
    },
    async replace(key, expectedRevision, value, actorUserId) {
      return UserSettingsAreaModel.findOneAndUpdate(
        { userId, areaKey: key, revision: expectedRevision },
        { $set: { value, revision: expectedRevision + 1, updatedBy: actorUserId } },
        { new: true },
      )
        .lean()
        .exec();
    },
    async writeAudit(key, actorUserId, before, after) {
      await UnscopedSettingsAuditModel.create({
        scope: 'SELF',
        subjectId: userId,
        areaKey: key,
        actorUserId,
        before,
        after,
      });
    },
    async history(key, limit) {
      const rows = await UnscopedSettingsAuditModel.find({ scope: 'SELF', subjectId: userId, areaKey: key })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean()
        .exec();
      return rows.map((row) =>
        toAuditView(row._id, key, row.actorUserId, row.createdAt, row.before, row.after),
      );
    },
  };
}

const globalStore: AreaStore = {
  async read(key) {
    return PlatformSettingsAreaModel.findOne({ areaKey: key }).lean().exec();
  },
  async insertFirst(key, value, actorUserId) {
    try {
      const created = await PlatformSettingsAreaModel.create({
        areaKey: key,
        value,
        revision: 1,
        updatedBy: actorUserId,
      });
      return created.toObject();
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    }
  },
  async replace(key, expectedRevision, value, actorUserId) {
    return PlatformSettingsAreaModel.findOneAndUpdate(
      { areaKey: key, revision: expectedRevision },
      { $set: { value, revision: expectedRevision + 1, updatedBy: actorUserId } },
      { new: true },
    )
      .lean()
      .exec();
  },
  async writeAudit(key, actorUserId, before, after) {
    await UnscopedSettingsAuditModel.create({
      scope: 'GLOBAL',
      subjectId: PLATFORM_SUBJECT,
      areaKey: key,
      actorUserId,
      before,
      after,
    });
  },
  async history(key, limit) {
    const rows = await UnscopedSettingsAuditModel.find({
      scope: 'GLOBAL',
      subjectId: PLATFORM_SUBJECT,
      areaKey: key,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return rows.map((row) =>
      toAuditView(row._id, key, row.actorUserId, row.createdAt, row.before, row.after),
    );
  },
};

function toAuditView(
  id: string,
  areaKey: string,
  actorUserId: string | null,
  at: Date,
  before: unknown,
  after: unknown,
): AuditEntryView {
  return {
    id,
    areaKey,
    actorUserId,
    at: at.toISOString(),
    before: readValue(before, areaKey),
    after: readValue(after, areaKey),
  };
}

/**
 * A stored document holds only what was saved. The defaults underneath it are
 * the registry's, so an area gaining a field reads as that field's default
 * everywhere rather than as a missing value the frontend has to guess at.
 */
function mergeOver(area: AreaDefinition, base: AreaValue, top: AreaValue): AreaValue {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(area.sections)) {
    merged[name] = { ...(base[name] ?? {}), ...(top[name] ?? {}) };
  }
  const parsed = fullSchemaOf(area).safeParse(merged);
  if (!parsed.success) {
    throw fail('INTERNAL', `Stored ${area.key} settings no longer satisfy the ${area.key} schema`);
  }
  return readValue(parsed.data, area.key);
}

async function readArea(area: AreaDefinition, store: AreaStore): Promise<AreaView> {
  const row = await store.read(area.key);
  const stored = row === null ? {} : readValue(row.value, area.key);
  return {
    key: area.key,
    scope: area.scope,
    revision: row?.revision ?? 0,
    defaultsApplied: row === null,
    updatedAt: row === null ? null : row.updatedAt.toISOString(),
    updatedBy: row?.updatedBy ?? null,
    value: mergeOver(area, defaultsOf(area), stored),
  };
}

async function patchArea(
  area: AreaDefinition,
  store: AreaStore,
  rawPatch: unknown,
  expectedRevision: number | undefined,
  actorUserId: string | null,
): Promise<AreaView> {
  const parsedPatch = patchSchemaOf(area).safeParse(rawPatch);
  if (!parsedPatch.success) throw fromZod(parsedPatch.error);
  const patch = readValue(parsedPatch.data, area.key);

  const current = await readArea(area, store);
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw conflict(`Settings changed since revision ${expectedRevision}. Reload and try again.`);
  }
  if (Object.keys(patch).length === 0) return current;

  const after = mergeOver(area, current.value, patch);

  // revision 0 is the absence of a document, so the first save is an insert the
  // unique index arbitrates, and every later one is conditional on the revision
  // it was based on. Neither path can overwrite a version it never saw.
  const saved =
    current.revision === 0
      ? await store.insertFirst(area.key, after, actorUserId)
      : await store.replace(area.key, current.revision, after, actorUserId);
  if (saved === null) throw conflict('Settings changed while saving. Reload and try again.');

  // written after the value: an audit row for a change that did not happen is
  // worse than one that arrives a moment later
  await store.writeAudit(area.key, actorUserId, current.value, after);

  return {
    key: area.key,
    scope: area.scope,
    revision: saved.revision,
    defaultsApplied: false,
    updatedAt: saved.updatedAt.toISOString(),
    updatedBy: saved.updatedBy,
    value: after,
  };
}

/**
 * Route policy can only name one capability for a path, and these paths carry
 * the area in a parameter. The policy therefore states the floor, may you open
 * settings at all, and the area's own capability is enforced here, where the
 * area is known. A service call that skipped the route would still be checked.
 */
function requireAreaCapability(capability: SettingsCapability | null): void {
  if (capability !== null) requireCapability(capability);
}

/**
 * Platform capability, checked against the memberships rather than the current
 * scope. A platform route runs in a system scope, in which the kernel's
 * capability check passes unconditionally, so relying on it here would leave
 * the platform areas open to any authenticated caller.
 */
function requirePlatformCapability(actor: Principal, capability: SettingsCapability | null): void {
  if (capability === null) {
    throw fail('INTERNAL', 'A platform area must declare the capability that gates it');
  }
  const granted = actor.memberships.some((m) => m.active && m.capabilities.includes(capability));
  if (!granted) throw forbidden(`Requires ${capability}`);
}

function holdsAnywhere(actor: Principal, capability: SettingsCapability | null): boolean {
  if (capability === null) return false;
  return actor.memberships.some((m) => m.active && m.capabilities.includes(capability));
}

export async function readOrgArea(key: OrgAreaKey): Promise<AreaView> {
  const area = areaOf(key);
  requireAreaCapability(area.readCapability);
  return readArea(area, orgStore);
}

export async function patchOrgArea(
  key: OrgAreaKey,
  patch: unknown,
  expectedRevision?: number,
): Promise<AreaView> {
  const area = areaOf(key);
  requireAreaCapability(area.writeCapability);
  return patchArea(area, orgStore, patch, expectedRevision, requirePrincipal().userId);
}

export async function readOrgAreaAudit(key: OrgAreaKey, limit: number): Promise<AuditEntryView[]> {
  const area = areaOf(key);
  requireAreaCapability(area.readCapability);
  return orgStore.history(area.key, limit);
}

/**
 * Personal settings take no user argument. The row is the caller's own, always,
 * which is the whole reason these routes need no capability: there is no
 * request shape that reaches somebody else's preferences.
 */
export async function readSelfArea(key: SelfAreaKey): Promise<AreaView> {
  const area = areaOf(key);
  return readArea(area, selfStore(requirePrincipal().userId));
}

export async function patchSelfArea(
  key: SelfAreaKey,
  patch: unknown,
  expectedRevision?: number,
): Promise<AreaView> {
  const area = areaOf(key);
  const userId = requirePrincipal().userId;
  return patchArea(area, selfStore(userId), patch, expectedRevision, userId);
}

export async function readSelfAreaAudit(key: SelfAreaKey, limit: number): Promise<AuditEntryView[]> {
  const area = areaOf(key);
  return selfStore(requirePrincipal().userId).history(area.key, limit);
}

/**
 * Platform areas run outside any organisation, so there are no scope
 * capabilities for the kernel's guard to check and the grant is looked for in
 * the caller's memberships instead. It is the platform that writes those
 * memberships, so holding settings.platform anywhere is the platform saying so.
 */
export async function readGlobalArea(key: GlobalAreaKey): Promise<AreaView> {
  const area = areaOf(key);
  requirePlatformCapability(requirePrincipal(), area.readCapability);
  return readArea(area, globalStore);
}

export async function patchGlobalArea(
  key: GlobalAreaKey,
  patch: unknown,
  expectedRevision?: number,
): Promise<AreaView> {
  const area = areaOf(key);
  const actor = requirePrincipal();
  requirePlatformCapability(actor, area.writeCapability);
  return patchArea(area, globalStore, patch, expectedRevision, actor.userId);
}

export async function readGlobalAreaAudit(key: GlobalAreaKey, limit: number): Promise<AuditEntryView[]> {
  const area = areaOf(key);
  requirePlatformCapability(requirePrincipal(), area.readCapability);
  return globalStore.history(area.key, limit);
}

function canRead(area: AreaDefinition, actor: Principal): boolean {
  switch (area.scope) {
    case 'SELF':
      return true;
    case 'ORG':
      return area.readCapability === null || hasCapability(area.readCapability);
    case 'GLOBAL':
      return holdsAnywhere(actor, area.readCapability);
  }
}

function canWrite(area: AreaDefinition, actor: Principal): boolean {
  switch (area.scope) {
    case 'SELF':
      return true;
    case 'ORG':
      return area.writeCapability === null || hasCapability(area.writeCapability);
    case 'GLOBAL':
      return holdsAnywhere(actor, area.writeCapability);
  }
}

/**
 * The catalogue the settings hub renders. Only the areas this caller may open
 * appear in it, because a menu that lists what you may not have is both a
 * usability failure and a description of the system for whoever is mapping it.
 */
export function buildCatalogue(): CatalogueEntry[] {
  const actor = requirePrincipal();
  const entries: CatalogueEntry[] = [];

  for (const area of ALL_AREAS) {
    if (!canRead(area, actor)) continue;
    entries.push({
      key: area.key,
      scope: area.scope,
      title: area.title,
      description: area.description,
      icon: area.icon,
      route: area.route,
      api: apiPathOf(area),
      readCapability: area.readCapability,
      writeCapability: area.writeCapability,
      writable: canWrite(area, actor),
    });
  }

  for (const link of LINK_AREAS) {
    if (link.readCapability !== null && !hasCapability(link.readCapability)) continue;
    entries.push({
      key: link.key,
      scope: link.scope,
      title: link.title,
      description: link.description,
      icon: link.icon,
      route: link.route,
      api: link.api,
      readCapability: link.readCapability,
      writeCapability: link.writeCapability,
      writable: link.writeCapability === null || hasCapability(link.writeCapability),
    });
  }

  return entries;
}

/** What the settings screen opens with, in one round trip. */
export async function readHub(): Promise<{
  scopedTo: string;
  catalogue: CatalogueEntry[];
  lists: Array<{ kind: ListKind; liveCount: number }>;
}> {
  const catalogue = buildCatalogue();
  // the hub needs no capability, so the list counts are only included for a
  // caller the catalogue already offered the lists area to
  const offersLists = catalogue.some((entry) => entry.key === 'lists');
  const lists = offersLists ? await summariseLists() : [];
  return { scopedTo: requireOrgId(), catalogue, lists };
}
