import type { ClientSession } from 'mongoose';
import { evaluateLockGate, explainGate } from '@csq/core';
import { TenantRepo } from '../../kernel/tenancy.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { requirePrincipal } from '../../kernel/requestContext.js';
import { appendAudit } from './sampling.audit.js';
import { inTransaction } from './sampling.db.js';
import { countEligible, loadContacts, loadEligible, toContactView, updateContact } from './sampling.contacts.js';
import { recordIntegrity } from './sampling.integrity.js';
import { effectiveMinimum, loadCyclePolicy, loadSamplingSettings } from './sampling.policy.js';
import {
  SamplingBatchModel,
  type CyclePolicyDoc,
  type LockGateDoc,
  type SamplingBatchDoc,
} from './sampling.models.js';
import type {
  BatchQuery,
  BatchView,
  ContactView,
  CreateBatch,
  DiffView,
  GateView,
  RejectionReasonCode,
  ReviewReasonCode,
  UpdateContact,
} from './sampling.contracts.js';

/**
 * Sampling batches: selection, the lock gate, and review.
 *
 * Two rules shape the whole file. The gate itself is never reimplemented here;
 * evaluateLockGate in @csq/core is the only thing that decides whether a sample
 * may be locked, and this file's job is to hand it honest counts. And the
 * minimum is cumulative across the cycle rather than per batch, because repeat
 * sampling is a requirement: a second batch of eleven late arrivals must not be
 * refused for being smaller on its own than a minimum the cycle already met.
 */

const batches = new TenantRepo<SamplingBatchDoc>(SamplingBatchModel);

/** States whose members are already part of this cycle's sample. */
const COMMITTED_STATES = ['PENDING_REVIEW', 'APPROVED'] as const;

function toGateView(gate: LockGateDoc): GateView {
  return {
    minimumSamplingSize: gate.minimumSamplingSize,
    eligibleCount: gate.eligibleCount,
    cumulativeSelectedCount: gate.cumulativeSelectedCount,
    selectedCount: gate.selectedCount,
    ok: gate.ok,
    mustSelectAll: gate.mustSelectAll,
    shortfall: gate.shortfall,
    reason: gate.reason,
    needed: gate.needed,
    explanation: gate.explanation,
  };
}

function toBatchView(doc: SamplingBatchDoc): BatchView {
  return {
    id: doc._id,
    cycleId: doc.cycleId,
    formScope: doc.formScope,
    label: doc.label,
    state: doc.state,
    contactCount: doc.selection.length,
    submittedCount: doc.submitted.length,
    lockedAt: doc.lockedAt === null ? null : doc.lockedAt.toISOString(),
    lockedBy: doc.lockedBy,
    approvalMode: doc.approvalMode,
    decidedAt: doc.decidedAt === null ? null : doc.decidedAt.toISOString(),
    decidedBy: doc.decidedBy,
    rejection:
      doc.rejection === null
        ? null
        : {
            reasonCode: doc.rejection.reasonCode,
            findings: doc.rejection.findings.map((finding) => ({ ...finding })),
            note: doc.rejection.note,
          },
    lockGate: doc.lockGate === null ? null : toGateView(doc.lockGate),
    createdAt: doc.createdAt.toISOString(),
  };
}

async function loadBatch(batchId: string, session?: ClientSession): Promise<SamplingBatchDoc> {
  const query = batches.findById(batchId);
  if (session) query.session(session);
  const doc = await query.lean().exec();
  if (!doc) throw notFound('No such sampling batch');
  return doc;
}

/**
 * Open and closed are different refusals. "Not yet" tells an operator to wait;
 * "closed" tells them the cycle has moved on, and answering both with the same
 * code would have the support desk guessing which one it was.
 */
function requireSamplingWindow(policy: CyclePolicyDoc, now: Date): void {
  if (now < policy.samplingOpens.utc) {
    throw fail('WINDOW_NOT_OPEN', `Sampling opens ${policy.samplingOpens.wall} ${policy.samplingOpens.tz}`);
  }
  if (now >= policy.samplingCloses.utc) {
    throw fail('WINDOW_CLOSED', `Sampling closed ${policy.samplingCloses.wall} ${policy.samplingCloses.tz}`);
  }
}

export async function createBatch(input: CreateBatch, now: Date): Promise<BatchView> {
  const policy = await loadCyclePolicy(input.cycleId);
  requireSamplingWindow(policy, now);

  const created = await batches.create({
    cycleId: input.cycleId,
    formScope: input.formScope,
    label: input.label,
    state: 'DRAFT',
    selection: [],
    submitted: [],
    lockedSnapshot: [],
    createdBy: requirePrincipal().userId,
  });

  await appendAudit([
    {
      action: 'BATCH_CREATED',
      subjectType: 'BATCH',
      subjectId: created._id,
      batchId: created._id,
      detail: { cycleId: input.cycleId, formScope: input.formScope },
    },
  ]);
  return toBatchView(created.toObject());
}

export async function readBatch(batchId: string): Promise<BatchView> {
  return toBatchView(await loadBatch(batchId));
}

export async function listBatches(query: BatchQuery): Promise<{ batches: BatchView[]; nextCursor: string | null }> {
  const filter: Record<string, unknown> = {};
  if (query.cycleId !== undefined) filter['cycleId'] = query.cycleId;
  if (query.state !== undefined) filter['state'] = query.state;
  if (query.cursor !== undefined) filter['_id'] = { $lt: query.cursor };

  const rows = await batches
    .find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean()
    .exec();

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    batches: page.map(toBatchView),
    nextCursor: rows.length > query.limit && last !== undefined ? last._id : null,
  };
}

/** Everyone already locked into this cycle, excluding the batch being evaluated. */
async function alreadySampled(
  cycleId: string,
  exceptBatchId: string,
  session?: ClientSession,
): Promise<Set<string>> {
  const query = batches.find(
    { cycleId, state: { $in: [...COMMITTED_STATES] }, _id: { $ne: exceptBatchId } },
    { selection: 1 },
  );
  if (session) query.session(session);

  const rows = await query.lean().exec();
  const ids = new Set<string>();
  for (const row of rows) for (const id of row.selection) ids.add(id);
  return ids;
}

async function computeGate(
  batch: SamplingBatchDoc,
  policy: CyclePolicyDoc,
  session?: ClientSession,
): Promise<LockGateDoc> {
  const minimumSamplingSize = effectiveMinimum(policy);
  // the directory count is a snapshot and is not read inside the transaction.
  // What the lock actually freezes is the selection, and that read is session
  // scoped below, so a contact added a moment later cannot change what was locked
  const eligibleCount = await countEligible(batch.formScope);

  const cumulative = await alreadySampled(batch.cycleId, batch._id, session);
  for (const id of batch.selection) cumulative.add(id);

  const outcome = evaluateLockGate({
    eligibleCount,
    selectedCount: cumulative.size,
    minimumSamplingSize,
  });

  return {
    minimumSamplingSize,
    eligibleCount,
    cumulativeSelectedCount: cumulative.size,
    selectedCount: batch.selection.length,
    ok: outcome.ok,
    mustSelectAll: outcome.ok ? outcome.mustSelectAll : false,
    shortfall: outcome.ok && outcome.mustSelectAll ? outcome.shortfall : 0,
    reason: outcome.ok ? null : outcome.reason,
    needed: outcome.ok ? 0 : outcome.needed,
    explanation: explainGate(outcome, minimumSamplingSize),
  };
}

export async function previewGate(batchId: string): Promise<GateView> {
  const batch = await loadBatch(batchId);
  const policy = await loadCyclePolicy(batch.cycleId);
  return toGateView(await computeGate(batch, policy));
}

function requireDistinct(contactIds: readonly string[]): void {
  if (new Set(contactIds).size !== contactIds.length) {
    throw fail('VALIDATION_FAILED', 'The same contact appears twice in the selection');
  }
}

/**
 * Unknown and ineligible are answered the same way on purpose. An id that
 * belongs to another organisation is simply not found here, and a refusal that
 * distinguished the two would say whether a guessed id exists somewhere.
 */
async function requireEligible(
  batch: SamplingBatchDoc,
  contactIds: readonly string[],
  session?: ClientSession,
): Promise<void> {
  const found = await loadEligible(batch.formScope, contactIds, session);
  if (found.length === contactIds.length) return;

  const present = new Set(found.map((contact) => contact._id));
  const missing = contactIds.filter((id) => !present.has(id));
  throw fail(
    'VALIDATION_FAILED',
    'Some contacts cannot be sampled',
    missing.slice(0, 20).map((id) => ({
      path: `contactIds.${id}`,
      message: `not an active ${batch.formScope} contact in this directory`,
    })),
  );
}

export async function setSelection(batchId: string, contactIds: readonly string[]): Promise<BatchView> {
  requireDistinct(contactIds);

  const batch = await loadBatch(batchId);
  if (batch.state !== 'DRAFT') {
    throw fail('BATCH_ALREADY_LOCKED', 'This batch is locked. Changes now go through review.');
  }
  await requireEligible(batch, contactIds);

  const updated = await batches
    .findOneAndUpdate({ _id: batchId, state: 'DRAFT' }, { $set: { selection: [...contactIds] } })
    .lean()
    .exec();
  if (!updated) throw fail('BATCH_ALREADY_LOCKED', 'This batch was locked while you were editing it');

  await appendAudit([
    {
      action: 'BATCH_SELECTION_SET',
      subjectType: 'BATCH',
      subjectId: batchId,
      batchId,
      detail: { selected: contactIds.length, was: batch.selection.length },
    },
  ]);
  return toBatchView(updated);
}

/**
 * The lock, in one transaction: freeze what the operator submitted, snapshot
 * the contacts as they were at that instant, record the integrity observations,
 * and write the audit entry. Locking an already locked batch is a no op that
 * returns the same batch, so a retried request cannot produce a second sample.
 */
export async function lockBatch(batchId: string, now: Date): Promise<BatchView> {
  const existing = await loadBatch(batchId);
  if (existing.state !== 'DRAFT') return toBatchView(existing);

  const locked = await inTransaction(async (session) => {
    const batch = await loadBatch(batchId, session);
    if (batch.state !== 'DRAFT') return batch;

    const policy = await loadCyclePolicy(batch.cycleId);
    requireSamplingWindow(policy, now);

    const gate = await computeGate(batch, policy, session);
    if (!gate.ok) throw fail('SAMPLING_BELOW_MINIMUM', gate.explanation);

    const contacts = await loadEligible(batch.formScope, batch.selection, session);
    if (contacts.length !== batch.selection.length) {
      throw conflict('A selected contact is no longer eligible. Review the selection and lock again.');
    }

    const settings = await loadSamplingSettings();
    const autoApproved = settings.approvalMode === 'AUTO';
    const actor = requirePrincipal();

    const updated = await batches
      .findOneAndUpdate(
        { _id: batchId, state: 'DRAFT' },
        {
          $set: {
            state: autoApproved ? 'APPROVED' : 'PENDING_REVIEW',
            submitted: [...batch.selection],
            lockedSnapshot: contacts.map((contact) => ({
              contactId: contact._id,
              email: contact.email,
              company: contact.company,
              customerType: contact.customerType,
              formScope: contact.formScope,
              phoneE164: contact.phoneE164,
            })),
            lockedAt: now,
            lockedBy: actor.userId,
            approvalMode: settings.approvalMode,
            decidedAt: autoApproved ? now : null,
            decidedBy: autoApproved ? actor.userId : null,
            lockGate: gate,
          },
        },
        { session },
      )
      .lean()
      .exec();

    // another request won the lock between the read and the write
    if (!updated) return loadBatch(batchId, session);

    await recordIntegrity(
      { batchId, cycleId: batch.cycleId, contacts, settings, observedAt: now },
      session,
    );

    await appendAudit(
      [
        {
          action: 'BATCH_LOCKED',
          subjectType: 'BATCH',
          subjectId: batchId,
          batchId,
          detail: {
            contacts: contacts.length,
            cumulative: gate.cumulativeSelectedCount,
            minimum: gate.minimumSamplingSize,
            mustSelectAll: gate.mustSelectAll,
            shortfall: gate.shortfall,
            approvalMode: settings.approvalMode,
          },
        },
      ],
      session,
    );

    return updated;
  });

  return toBatchView(locked);
}

function requireUnderReview(batch: SamplingBatchDoc): void {
  if (batch.state === 'DRAFT') throw conflict('This batch has not been locked yet');
  if (batch.state !== 'PENDING_REVIEW') throw conflict(`This batch is already ${batch.state.toLowerCase()}`);
}

export async function reviewAdd(
  batchId: string,
  contactIds: readonly string[],
  reasonCode: ReviewReasonCode,
  note: string | null,
): Promise<BatchView> {
  requireDistinct(contactIds);
  const batch = await loadBatch(batchId);
  requireUnderReview(batch);
  await requireEligible(batch, contactIds);

  const current = new Set(batch.selection);
  const toAdd = contactIds.filter((id) => !current.has(id));
  if (toAdd.length === 0) return toBatchView(batch);

  const at = new Date();
  const actor = requirePrincipal();
  const updated = await batches
    .findOneAndUpdate(
      { _id: batchId, state: 'PENDING_REVIEW' },
      {
        $push: {
          selection: { $each: toAdd },
          reviewChanges: {
            $each: toAdd.map((contactId) => ({
              at,
              by: actor.userId,
              kind: 'ADD' as const,
              contactId,
              reasonCode,
              note,
              fields: [],
            })),
          },
        },
      },
    )
    .lean()
    .exec();
  if (!updated) throw conflict('This batch left review while you were editing it');

  await appendAudit(
    toAdd.map((contactId) => ({
      action: 'BATCH_CONTACT_ADDED' as const,
      subjectType: 'BATCH' as const,
      subjectId: batchId,
      batchId,
      reasonCode,
      detail: { contactId, note: note ?? '' },
    })),
  );
  return toBatchView(updated);
}

export async function reviewRemove(
  batchId: string,
  contactIds: readonly string[],
  reasonCode: ReviewReasonCode,
  note: string | null,
): Promise<BatchView> {
  requireDistinct(contactIds);
  const batch = await loadBatch(batchId);
  requireUnderReview(batch);

  const current = new Set(batch.selection);
  const toRemove = contactIds.filter((id) => current.has(id));
  if (toRemove.length === 0) return toBatchView(batch);

  const at = new Date();
  const actor = requirePrincipal();
  const updated = await batches
    .findOneAndUpdate(
      { _id: batchId, state: 'PENDING_REVIEW' },
      {
        $pull: { selection: { $in: toRemove } },
        $push: {
          reviewChanges: {
            $each: toRemove.map((contactId) => ({
              at,
              by: actor.userId,
              kind: 'REMOVE' as const,
              contactId,
              reasonCode,
              note,
              fields: [],
            })),
          },
        },
      },
    )
    .lean()
    .exec();
  if (!updated) throw conflict('This batch left review while you were editing it');

  await appendAudit(
    toRemove.map((contactId) => ({
      action: 'BATCH_CONTACT_REMOVED' as const,
      subjectType: 'BATCH' as const,
      subjectId: batchId,
      batchId,
      reasonCode,
      detail: { contactId, note: note ?? '' },
    })),
  );
  return toBatchView(updated);
}

/**
 * A correction edits the contact itself, because a mistyped address is wrong
 * everywhere and not only in this batch. What the batch records is that a
 * reviewer changed it, which fields, and why.
 */
export async function reviewCorrect(
  batchId: string,
  contactId: string,
  changes: UpdateContact,
  reasonCode: ReviewReasonCode,
  note: string | null,
): Promise<{ batch: BatchView; contact: ContactView }> {
  const batch = await loadBatch(batchId);
  requireUnderReview(batch);
  if (!batch.selection.includes(contactId)) {
    throw notFound('That contact is not in this batch');
  }

  const contact = await updateContact(contactId, changes);
  const at = new Date();
  const actor = requirePrincipal();

  const updated = await batches
    .findOneAndUpdate(
      { _id: batchId, state: 'PENDING_REVIEW' },
      {
        $push: {
          reviewChanges: {
            at,
            by: actor.userId,
            kind: 'CORRECT' as const,
            contactId,
            reasonCode,
            note,
            fields: Object.keys(changes).sort(),
          },
        },
      },
    )
    .lean()
    .exec();
  if (!updated) throw conflict('This batch left review while you were editing it');

  await appendAudit([
    {
      action: 'BATCH_CONTACT_CORRECTED',
      subjectType: 'BATCH',
      subjectId: batchId,
      batchId,
      reasonCode,
      detail: { contactId, fields: Object.keys(changes).sort().join(','), note: note ?? '' },
    },
  ]);
  return { batch: toBatchView(updated), contact };
}

/** What the reviewer changed, measured against what the operator submitted. */
export async function diffBatch(batchId: string): Promise<DiffView> {
  const batch = await loadBatch(batchId);

  const submitted = new Set(batch.submitted);
  const current = new Set(batch.selection);
  const addedIds = batch.selection.filter((id) => !submitted.has(id));
  const removedIds = batch.submitted.filter((id) => !current.has(id));

  const contacts = await loadContacts([...addedIds, ...removedIds]);
  const byId = new Map(contacts.map((contact) => [contact._id, toContactView(contact)]));
  const view = (id: string): ContactView | undefined => byId.get(id);

  return {
    batchId: batch._id,
    state: batch.state,
    submittedCount: batch.submitted.length,
    currentCount: batch.selection.length,
    added: addedIds.map(view).filter((row): row is ContactView => row !== undefined),
    removed: removedIds.map(view).filter((row): row is ContactView => row !== undefined),
    corrected: batch.reviewChanges
      .filter((change) => change.kind === 'CORRECT')
      .map((change) => ({
        contactId: change.contactId,
        fields: [...change.fields],
        reasonCode: change.reasonCode,
        at: change.at.toISOString(),
        by: change.by,
      })),
    changes: batch.reviewChanges.map((change) => ({
      at: change.at.toISOString(),
      by: change.by,
      kind: change.kind,
      contactId: change.contactId,
      reasonCode: change.reasonCode,
      note: change.note,
    })),
  };
}

export async function approveBatch(batchId: string, note: string | null): Promise<BatchView> {
  const batch = await loadBatch(batchId);
  if (batch.state === 'APPROVED') return toBatchView(batch);
  requireUnderReview(batch);

  // the reviewer may have removed people, so the gate has to hold again on the
  // list actually being approved rather than on the one that was submitted
  const policy = await loadCyclePolicy(batch.cycleId);
  const gate = await computeGate(batch, policy);
  if (!gate.ok) throw fail('SAMPLING_BELOW_MINIMUM', gate.explanation);

  const actor = requirePrincipal();
  const updated = await batches
    .findOneAndUpdate(
      { _id: batchId, state: 'PENDING_REVIEW' },
      { $set: { state: 'APPROVED', decidedAt: new Date(), decidedBy: actor.userId, lockGate: gate } },
    )
    .lean()
    .exec();
  if (!updated) throw conflict('This batch left review while you were deciding');

  await appendAudit([
    {
      action: 'BATCH_APPROVED',
      subjectType: 'BATCH',
      subjectId: batchId,
      batchId,
      detail: {
        contacts: updated.selection.length,
        added: updated.reviewChanges.filter((change) => change.kind === 'ADD').length,
        removed: updated.reviewChanges.filter((change) => change.kind === 'REMOVE').length,
        corrected: updated.reviewChanges.filter((change) => change.kind === 'CORRECT').length,
        note: note ?? '',
      },
    },
  ]);
  return toBatchView(updated);
}

export async function rejectBatch(
  batchId: string,
  rejection: {
    reasonCode: RejectionReasonCode;
    findings: ReadonlyArray<{ contactId: string | null; detail: string }>;
    note: string | null;
  },
): Promise<BatchView> {
  const batch = await loadBatch(batchId);
  if (batch.state === 'REJECTED') return toBatchView(batch);
  requireUnderReview(batch);

  const actor = requirePrincipal();
  const updated = await batches
    .findOneAndUpdate(
      { _id: batchId, state: 'PENDING_REVIEW' },
      {
        $set: {
          state: 'REJECTED',
          decidedAt: new Date(),
          decidedBy: actor.userId,
          rejection: {
            reasonCode: rejection.reasonCode,
            findings: rejection.findings.map((finding) => ({ ...finding })),
            note: rejection.note,
          },
        },
      },
    )
    .lean()
    .exec();
  if (!updated) throw conflict('This batch left review while you were deciding');

  await appendAudit([
    {
      action: 'BATCH_REJECTED',
      subjectType: 'BATCH',
      subjectId: batchId,
      batchId,
      reasonCode: rejection.reasonCode,
      detail: { findings: rejection.findings.length, note: rejection.note ?? '' },
    },
  ]);
  return toBatchView(updated);
}
