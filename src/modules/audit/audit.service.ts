import type { FilterQuery } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { idString, toId } from '../../core/ids.js';
import { logger } from '../../core/logger.js';
import { escapeRegex, pageOf, parseSort, skipLimit, type Page } from '../../core/pagination.js';

import { AuditModel, type AuditDoc } from './audit.model.js';
import type { AuditEntryDto, AuditListQuery } from './audit.schemas.js';

export interface AuditEntry {
  /** `entity.verb`, from the list in ARCHITECTURE §7. */
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  /** The organisation the entry concerns; defaults to the actor's active organisation. */
  orgId?: string | null;
}

/**
 * Writes one audit row. Pass `null` as ctx for system actions (scheduler,
 * seed). Never throws: a failed audit write is logged, not surfaced, because
 * the state change it describes has already happened.
 */
export async function audit(ctx: RequestContext | null, entry: AuditEntry): Promise<void> {
  const orgId = entry.orgId === undefined ? (ctx?.org.id ?? null) : entry.orgId;
  try {
    await AuditModel.create({
      actorUserId: ctx ? toId(ctx.user.id) : null,
      actorEmail: ctx?.user.email ?? null,
      actorOrgId: ctx ? toId(ctx.org.id) : null,
      orgId: orgId === null ? null : toId(orgId),
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      before: entry.before,
      after: entry.after,
      ip: ctx?.ip ?? '',
      requestId: ctx?.requestId ?? '',
      at: new Date(),
    });
  } catch (error) {
    logger.error({ err: error, action: entry.action, entity: entry.entity }, 'Audit write failed');
  }
}

function toDto(doc: AuditDoc): AuditEntryDto {
  return {
    id: idString(doc._id),
    actorUserId: doc.actorUserId ? idString(doc.actorUserId) : null,
    actorEmail: doc.actorEmail,
    actorOrgId: doc.actorOrgId ? idString(doc.actorOrgId) : null,
    orgId: doc.orgId ? idString(doc.orgId) : null,
    action: doc.action,
    entity: doc.entity,
    entityId: doc.entityId,
    before: doc.before,
    after: doc.after,
    ip: doc.ip,
    requestId: doc.requestId,
    at: doc.at.toISOString(),
  };
}

const SORTABLE = ['at', 'action', 'entity'] as const;

/** PLATFORM reads everything (optionally filtered by orgId); other scopes only their own organisation. */
export async function listAudit(ctx: RequestContext, query: AuditListQuery): Promise<Page<AuditEntryDto>> {
  const filter: FilterQuery<AuditDoc> = {};
  if (ctx.scope.kind === 'PLATFORM') {
    if (query.orgId) filter.orgId = toId(query.orgId);
  } else {
    filter.orgId = toId(ctx.org.id);
  }
  if (query.entity) filter.entity = query.entity;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.action) filter.action = query.action;
  if (query.actor) {
    filter.$or = /^[0-9a-fA-F]{24}$/.test(query.actor)
      ? [{ actorUserId: toId(query.actor) }, { actorEmail: new RegExp(escapeRegex(query.actor), 'i') }]
      : [{ actorEmail: new RegExp(escapeRegex(query.actor), 'i') }];
  }
  if (query.from || query.to) {
    filter.at = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
  }
  if (query.q) {
    const regex = new RegExp(escapeRegex(query.q), 'i');
    filter.$and = [{ $or: [{ action: regex }, { entity: regex }, { entityId: regex }, { actorEmail: regex }] }];
  }
  const sort = parseSort(query.sort, SORTABLE, '-at');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    AuditModel.find(filter).sort(sort).skip(skip).limit(limit).lean<AuditDoc[]>(),
    AuditModel.countDocuments(filter),
  ]);
  return pageOf(docs.map(toDto), total, query);
}
