import type { ClientSession } from 'mongoose';
import { TenantRepo } from '../../kernel/tenancy.js';
import { requirePrincipal } from '../../kernel/requestContext.js';
import { SamplingAuditModel, type SamplingAuditDoc } from './sampling.models.js';
import type { AuditAction, AuditEntryView, AuditQuery } from './sampling.contracts.js';

/**
 * Every mutation of the customer directory and of a batch's membership lands
 * here, with the actor and the instant. The collection refuses updates and
 * deletes at the schema, so this file is the only way a row is ever written and
 * there is no way at all for one to be rewritten.
 */

const audit = new TenantRepo<SamplingAuditDoc>(SamplingAuditModel);

export interface AuditDraft {
  readonly action: AuditAction;
  readonly subjectType: SamplingAuditDoc['subjectType'];
  readonly subjectId: string;
  readonly batchId?: string | null;
  readonly reasonCode?: string | null;
  /** Scalars only. An audit row is not a place to park a request body. */
  readonly detail?: Record<string, string | number | boolean>;
}

export async function appendAudit(
  drafts: readonly AuditDraft[],
  session?: ClientSession,
): Promise<void> {
  if (drafts.length === 0) return;
  const actor = requirePrincipal();
  const at = new Date();

  const rows = drafts.map((draft) => ({
    at,
    actorUserId: actor.userId,
    actorName: actor.displayName,
    action: draft.action,
    subjectType: draft.subjectType,
    subjectId: draft.subjectId,
    batchId: draft.batchId ?? null,
    reasonCode: draft.reasonCode ?? null,
    detail: draft.detail ?? {},
  }));

  // insertMany runs the tenancy plugin's hook, which stamps the organisation
  await SamplingAuditModel.insertMany(rows, session ? { session } : {});
}

function toView(doc: SamplingAuditDoc): AuditEntryView {
  return {
    id: doc._id,
    at: doc.at.toISOString(),
    actorUserId: doc.actorUserId,
    actorName: doc.actorName,
    action: doc.action,
    subjectType: doc.subjectType,
    subjectId: doc.subjectId,
    batchId: doc.batchId,
    reasonCode: doc.reasonCode,
    detail: { ...doc.detail },
  };
}

export async function listAudit(query: AuditQuery): Promise<{ entries: AuditEntryView[]; nextCursor: string | null }> {
  const filter: Record<string, unknown> = {};
  if (query.action !== undefined) filter['action'] = query.action;
  if (query.subjectId !== undefined) filter['subjectId'] = query.subjectId;
  if (query.batchId !== undefined) filter['batchId'] = query.batchId;
  // ids are ULIDs, so newest first is _id descending and the cursor is an id
  if (query.cursor !== undefined) filter['_id'] = { $lt: query.cursor };

  const rows = await audit
    .find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean()
    .exec();

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    entries: page.map(toView),
    nextCursor: rows.length > query.limit && last !== undefined ? last._id : null,
  };
}
