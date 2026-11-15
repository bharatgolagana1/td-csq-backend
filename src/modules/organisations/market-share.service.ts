import type { ClientSession, Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { idString, toId } from '../../core/ids.js';
import { findAirportsByIds, requireAirport } from '../airports/airports.service.js';
import { audit } from '../audit/audit.service.js';

import { MarketShareModel, type MarketShareDoc } from './market-shares.model.js';
import { OrganisationModel, type OrganisationDoc } from './organisations.model.js';
import type { MarketShareDto, MarketShareInput, ShareTotalDto } from './organisations.schemas.js';

/** Shares must total 100 within this tolerance (ARCHITECTURE §6). */
export const SHARE_TOLERANCE = 0.01;

/** Whether a set's total is 100 within the tolerance, compared to two decimals so 99.99 and 100.01 pass despite float sums. */
export function totalsHundred(total: number): boolean {
  return Math.abs(roundShare(total - 100)) <= SHARE_TOLERANCE;
}

/**
 * Whether a cycle's market-share snapshot is frozen. The cycles module
 * registers the real check (status beyond PUBLISHED) at boot; until then
 * nothing is frozen. Cycle-less (current) shares are never frozen.
 */
export type MarketShareFreezeCheck = (cycleId: string) => Promise<boolean>;

let freezeCheck: MarketShareFreezeCheck = async () => false;

export function registerMarketShareFreezeCheck(check: MarketShareFreezeCheck): void {
  freezeCheck = check;
}

export async function isMarketShareFrozen(cycleId: string | null): Promise<boolean> {
  return cycleId === null ? false : freezeCheck(cycleId);
}

/** Airport visibility: PLATFORM any; AIRPORT its own; ACO the airport it operates at. Otherwise 404. */
function assertAirportVisible(ctx: RequestContext, airportId: string): void {
  if (!airportVisible(ctx, airportId)) throw new AppError('NOT_FOUND', 'Airport not found');
}

/** Whether the caller may read an airport's shares (see assertAirportVisible). */
function airportVisible(ctx: RequestContext, airportId: string): boolean {
  return (
    ctx.scope.kind === 'PLATFORM' ||
    (ctx.scope.kind === 'AIRPORT' && ctx.scope.airportId === airportId) ||
    (ctx.scope.kind === 'ACO' && ctx.org.airportId === airportId)
  );
}

export function roundShare(value: number): number {
  return Math.round(value * 100) / 100;
}

async function loadSet(airportId: Types.ObjectId, cycleId: Types.ObjectId | null, session?: ClientSession): Promise<MarketShareDoc[]> {
  return MarketShareModel.find({ airportId, cycleId }, null, session ? { session } : {})
    .sort({ sharePct: -1 })
    .lean<MarketShareDoc[]>();
}

/** The entries of a set with operator codes and names, and their total. */
export interface ShareSetView {
  entries: MarketShareDto['entries'];
  total: number;
}

async function viewOf(docs: MarketShareDoc[], session?: ClientSession): Promise<ShareSetView> {
  const orgs = await OrganisationModel.find({ _id: { $in: docs.map((doc) => doc.acoId) } }, null, session ? { session } : {}).lean<OrganisationDoc[]>();
  const orgById = new Map(orgs.map((org) => [idString(org._id), org]));
  const entries = docs.map((doc) => {
    const org = orgById.get(idString(doc.acoId));
    return { acoId: idString(doc.acoId), code: org?.code ?? '?', name: org?.name ?? 'Unknown operator', sharePct: doc.sharePct };
  });
  return { entries, total: roundShare(entries.reduce((sum, entry) => sum + entry.sharePct, 0)) };
}

/** The airport's current (cycle-less) set as it stands, read inside `session` when given. */
export async function currentShareView(airportId: Types.ObjectId, session?: ClientSession): Promise<ShareSetView> {
  return viewOf(await loadSet(airportId, null, session), session);
}

async function toDto(airportId: string, cycleId: string | null, docs: MarketShareDoc[]): Promise<MarketShareDto> {
  const view = await viewOf(docs);
  return { airportId, cycleId, entries: view.entries, total: view.total, frozen: await isMarketShareFrozen(cycleId) };
}

export async function getMarketShare(ctx: RequestContext, airportId: string, cycleId: string | null): Promise<MarketShareDto> {
  assertAirportVisible(ctx, airportId);
  const airport = await requireAirport(airportId).catch(() => null);
  if (!airport) throw new AppError('NOT_FOUND', 'Airport not found');
  const docs = await loadSet(airport._id, cycleId ? toId(cycleId) : null);
  return toDto(airportId, cycleId, docs);
}

/**
 * Replaces the whole set for (airport, cycle). Validates every operator is an
 * ACO at this airport, no duplicates, and the total is 100 ± 0.01; refuses
 * when the cycle is frozen. Audited as `marketshare.updated`.
 */
export async function putMarketShare(ctx: RequestContext, airportId: string, input: MarketShareInput): Promise<MarketShareDto> {
  assertAirportVisible(ctx, airportId);
  const airport = await requireAirport(airportId).catch(() => null);
  if (!airport) throw new AppError('NOT_FOUND', 'Airport not found');
  const cycleId = input.cycleId ?? null;
  if (await isMarketShareFrozen(cycleId)) {
    throw new AppError('PRECONDITION_FAILED', 'Market shares for this cycle are frozen', { cycleId });
  }

  const issues: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  const operators = await OrganisationModel.find({
    _id: { $in: input.entries.map((entry) => toId(entry.acoId)) },
    type: 'ACO',
  }).lean<OrganisationDoc[]>();
  const operatorById = new Map(operators.map((org) => [idString(org._id), org]));
  input.entries.forEach((entry, index) => {
    const org = operatorById.get(entry.acoId);
    if (!org) issues.push({ path: `entries.${index}.acoId`, message: `Unknown operator ${entry.acoId}` });
    else if (!org.airportId || idString(org.airportId) !== airportId) {
      issues.push({ path: `entries.${index}.acoId`, message: `Operator ${org.code} does not operate at this airport` });
    }
    if (seen.has(entry.acoId)) issues.push({ path: `entries.${index}.acoId`, message: 'Operator listed twice' });
    seen.add(entry.acoId);
  });
  const total = input.entries.reduce((sum, entry) => sum + entry.sharePct, 0);
  if (!totalsHundred(total)) {
    issues.push({ path: 'entries', message: `Market shares must total 100 (got ${roundShare(total)})` });
  }
  if (issues.length > 0) throw new AppError('VALIDATION', 'Invalid market-share set', { issues });

  const cycleOid = cycleId ? toId(cycleId) : null;
  const before = await toDto(airportId, cycleId, await loadSet(airport._id, cycleOid));
  await withTransaction((session) =>
    writeShareSet({ airportId: airport._id, cycleId: cycleOid, entries: input.entries, setBy: toId(ctx.user.id), note: input.note ?? null }, session),
  );
  const after = await toDto(airportId, cycleId, await loadSet(airport._id, cycleOid));
  await auditShareChange(ctx, { airportId, cycleId, before, after });
  return after;
}

/** Replaces the set for (airport, cycle) with exactly `entries`, inside the caller's transaction; no validation. */
export async function writeShareSet(
  input: {
    airportId: Types.ObjectId;
    cycleId: Types.ObjectId | null;
    entries: { acoId: string; sharePct: number }[];
    setBy: Types.ObjectId | null;
    note: string | null;
  },
  session: ClientSession,
): Promise<void> {
  const { airportId, cycleId } = input;
  await MarketShareModel.deleteMany({ airportId, cycleId, acoId: { $nin: input.entries.map((entry) => toId(entry.acoId)) } }, { session });
  if (input.entries.length === 0) return;
  await MarketShareModel.bulkWrite(
    input.entries.map((entry) => ({
      updateOne: {
        filter: { airportId, cycleId, acoId: toId(entry.acoId) },
        update: {
          $set: { sharePct: entry.sharePct, setBy: input.setBy, note: input.note },
          $setOnInsert: { airportId, cycleId, acoId: toId(entry.acoId) },
        },
        upsert: true,
      },
    })),
    { session },
  );
}

/** A set before and after a change, for the `marketshare.updated` audit row. */
export interface ShareChange {
  airportId: string;
  cycleId: string | null;
  before: ShareSetView;
  after: ShareSetView;
}

/** Audits a written set as `marketshare.updated` (after the transaction commits). */
export async function auditShareChange(ctx: RequestContext, change: ShareChange): Promise<void> {
  await audit(ctx, {
    action: 'marketshare.updated',
    entity: 'airport.marketshare',
    entityId: change.cycleId ? `${change.airportId}:${change.cycleId}` : change.airportId,
    before: { entries: change.before.entries, total: change.before.total },
    after: { entries: change.after.entries, total: change.after.total },
  });
}

/**
 * `GET /market-share/totals`: each listed airport's current (cycle-less)
 * total and number of entries, in one aggregation, so a picker can flag every
 * airport whose shares do not total 100 (what publishing a cycle checks).
 * Airports outside the caller's scope and unknown ids are left out; an airport
 * without shares reads total 0.
 */
export async function currentShareTotals(ctx: RequestContext, airportIds: string[]): Promise<ShareTotalDto[]> {
  const visible = [...new Set(airportIds)].filter((id) => airportVisible(ctx, id));
  const airports = await findAirportsByIds(visible);
  const known = visible.filter((id) => airports.has(id));
  if (known.length === 0) return [];
  const rows = await MarketShareModel.aggregate<{ _id: Types.ObjectId; total: number; entries: number }>([
    { $match: { cycleId: null, airportId: { $in: known.map((id) => toId(id, 'airportId')) } } },
    { $group: { _id: '$airportId', total: { $sum: '$sharePct' }, entries: { $sum: 1 } } },
  ]);
  const byAirport = new Map(rows.map((row) => [idString(row._id), row]));
  return known.map((airportId) => {
    const row = byAirport.get(airportId);
    return { airportId, total: roundShare(row?.total ?? 0), entries: row?.entries ?? 0 };
  });
}

/** acoId → current (cycle-less) share, for operator summaries. */
export async function currentSharesForOperators(acoIds: Iterable<string | Types.ObjectId>): Promise<Map<string, number>> {
  const ids = [...new Set([...acoIds].map(idString))];
  if (ids.length === 0) return new Map();
  const docs = await MarketShareModel.find({ acoId: { $in: ids.map((id) => toId(id)) }, cycleId: null }).lean<MarketShareDoc[]>();
  return new Map(docs.map((doc) => [idString(doc.acoId), doc.sharePct]));
}

/** Sets one operator's current share without validating the airport total (operator creation / approval). */
export async function setCurrentShare(
  input: { airportId: Types.ObjectId; acoId: Types.ObjectId; sharePct: number; setBy: Types.ObjectId | null },
  session?: ClientSession,
): Promise<void> {
  await MarketShareModel.updateOne(
    { airportId: input.airportId, cycleId: null, acoId: input.acoId },
    { $set: { sharePct: input.sharePct, setBy: input.setBy }, $setOnInsert: { airportId: input.airportId, cycleId: null, acoId: input.acoId } },
    { upsert: true, ...(session ? { session } : {}) },
  );
}
