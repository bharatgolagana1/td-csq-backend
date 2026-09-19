import type { AnyBulkWriteOperation } from 'mongoose';
import { TenantRepo } from '../../kernel/tenancy.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { ListItemModel, type ListItemDoc } from './settings.models.js';
import { LIST_KINDS, type ListItemView, type ListKind } from './settings.contracts.js';

/**
 * The curated lists an organisation keeps for itself. Legal Genius calls these
 * labels, priorities and categories; the shape is the same everywhere: a named
 * set an administrator types in, ordered deliberately, and archived rather than
 * deleted because historical records point at the entries.
 *
 * No function here takes an organisation id. The tenancy plugin supplies it
 * from the request scope, so there is no argument to get wrong and no call site
 * that can be persuaded to pass someone else's.
 */

const items = new TenantRepo<ListItemDoc>(ListItemModel);

const DUPLICATE_KEY = 11000;

export function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY
  );
}

function foldLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function toItemView(doc: ListItemDoc): ListItemView {
  return {
    id: doc._id,
    kind: doc.kind,
    label: doc.label,
    colour: doc.colour,
    position: doc.position,
    archived: doc.archived,
  };
}

export async function summariseLists(): Promise<Array<{ kind: ListKind; liveCount: number }>> {
  const rows = await items
    .aggregate<{ _id: ListKind; liveCount: number }>([
      { $match: { archived: false } },
      { $group: { _id: '$kind', liveCount: { $sum: 1 } } },
    ])
    .exec();

  const counts = new Map(rows.map((r) => [r._id, r.liveCount]));
  return LIST_KINDS.map((kind) => ({ kind, liveCount: counts.get(kind) ?? 0 }));
}

export async function readList(kind: ListKind, includeArchived: boolean): Promise<ListItemView[]> {
  const filter = includeArchived ? { kind } : { kind, archived: false };
  const rows = await items.find(filter).sort({ position: 1, label: 1 }).lean().exec();
  return rows.map(toItemView);
}

export async function addListItem(
  kind: ListKind,
  input: { label: string; colour: string | null },
): Promise<ListItemView> {
  const last = await items.find({ kind }).sort({ position: -1 }).limit(1).lean().exec();
  const position = (last[0]?.position ?? -1) + 1;

  try {
    const created = await items.create({
      kind,
      label: input.label.trim(),
      labelKey: foldLabel(input.label),
      colour: input.colour,
      position,
      archived: false,
      archivedAt: null,
    });
    return toItemView(created.toObject());
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict(`${input.label.trim()} is already on this list`);
    throw error;
  }
}

export async function editListItem(
  kind: ListKind,
  itemId: string,
  input: { label?: string; colour?: string | null },
): Promise<ListItemView> {
  const assignments: Record<string, unknown> = {};
  if (input.label !== undefined) {
    assignments['label'] = input.label.trim();
    assignments['labelKey'] = foldLabel(input.label);
  }
  if (input.colour !== undefined) assignments['colour'] = input.colour;

  try {
    const updated = await items
      .findOneAndUpdate({ _id: itemId, kind }, { $set: assignments })
      .lean()
      .exec();
    if (!updated) throw notFound('No such list entry');
    return toItemView(updated);
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict('Another entry already uses that label');
    throw error;
  }
}

export async function archiveListItem(kind: ListKind, itemId: string): Promise<ListItemView> {
  const updated = await items
    .findOneAndUpdate(
      { _id: itemId, kind, archived: false },
      { $set: { archived: true, archivedAt: new Date() } },
    )
    .lean()
    .exec();
  if (!updated) throw notFound('No such list entry');
  return toItemView(updated);
}

/**
 * Reordering takes the whole live set, not a pair of indexes. A partial order
 * cannot be applied without inventing positions for the entries the client did
 * not mention, and inventing them is how two tabs end up disagreeing.
 */
export async function reorderList(kind: ListKind, itemIds: readonly string[]): Promise<ListItemView[]> {
  const live = await items.find({ kind, archived: false }).select('_id').lean().exec();
  const liveIds = new Set(live.map((row) => row._id));

  const offered = new Set(itemIds);
  if (offered.size !== itemIds.length) {
    throw fail('VALIDATION_FAILED', 'The same entry appears twice in the order');
  }
  if (offered.size !== liveIds.size || [...offered].some((id) => !liveIds.has(id))) {
    throw fail('VALIDATION_FAILED', 'The order must list every live entry of this kind exactly once');
  }

  // bulkWrite goes through the tenancy plugin, which rewrites each filter
  const operations: Array<AnyBulkWriteOperation<ListItemDoc>> = itemIds.map((id, index) => ({
    updateOne: { filter: { _id: id }, update: { $set: { position: index } } },
  }));
  await ListItemModel.bulkWrite(operations);

  return readList(kind, false);
}
