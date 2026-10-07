import type { ClientSession, Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { idString, toId } from '../../core/ids.js';
import { requireAirport } from '../airports/airports.service.js';
import { audit } from '../audit/audit.service.js';

import { MarketShareModel, type MarketShareDoc } from './market-shares.model.js';
import { OrganisationModel, type OrganisationDoc } from './organisations.model.js';
import type { MarketShareDto, MarketShareInput } from './organisations.schemas.js';

/** Shares must total 100 within this tolerance (ARCHITECTURE §6). */
export const SHARE_TOLERANCE = 0.01;

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
  const visible =
    ctx.scope.kind === 'PLATFORM' ||
    (ctx.scope.kind === 'AIRPORT' && ctx.scope.airportId === airportId) ||
    (ctx.scope.kind === 'ACO' && ctx.org.airportId === airportId);
  if (!visible) throw new AppError('NOT_FOUND', 'Airport not found');
}

async function loadSet(airportId: Types.ObjectId, cycleId: Types.ObjectId | null): Promise<MarketShareDoc[]> {
  return MarketShareModel.find({ airportId, cycleId }).sort({ sharePct: -1 }).lean<MarketShareDoc[]>();
}

async function toDto(airportId: string, cycleId: string | null, docs: MarketShareDoc[]): Promise<MarketShareDto> {
  const orgs = await OrganisationModel.find({ _id: { $in: docs.map((doc) => doc.acoId) } }).lean<OrganisationDoc[]>();
  const orgById = new Map(orgs.map((org) => [idString(org._id), org]));
  const entries = docs.map((doc) => {
    const org = orgById.get(idString(doc.acoId));
    return { acoId: idString(doc.acoId), code: org?.code ?? '?', name: org?.name ?? 'Unknown operator', sharePct: doc.sharePct };
  });
  const total = Math.round(entries.reduce((sum, entry) => sum + entry.sharePct, 0) * 100) / 100;
  return { airportId, cycleId, entries, total, frozen: await isMarketShareFrozen(cycleId) };
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
  if (Math.abs(total - 100) > SHARE_TOLERANCE) {
    issues.push({ path: 'entries', message: `Market shares must total 100 (got ${Math.round(total * 100) / 100})` });
  }
  if (issues.length > 0) throw new AppError('VALIDATION', 'Invalid market-share set', { issues });

  const cycleOid = cycleId ? toId(cycleId) : null;
  const before = await toDto(airportId, cycleId, await loadSet(airport._id, cycleOid));
  await withTransaction(async (session) => {
    await MarketShareModel.deleteMany(
      { airportId: airport._id, cycleId: cycleOid, acoId: { $nin: input.entries.map((entry) => toId(entry.acoId)) } },
      { session },
    );
    await MarketShareModel.bulkWrite(
      input.entries.map((entry) => ({
        updateOne: {
          filter: { airportId: airport._id, cycleId: cycleOid, acoId: toId(entry.acoId) },
          update: {
            $set: { sharePct: entry.sharePct, setBy: toId(ctx.user.id), note: input.note ?? null },
            $setOnInsert: { airportId: airport._id, cycleId: cycleOid, acoId: toId(entry.acoId) },
          },
          upsert: true,
        },
      })),
      { session },
    );
  });
  const after = await toDto(airportId, cycleId, await loadSet(airport._id, cycleOid));
  await audit(ctx, {
    action: 'marketshare.updated',
    entity: 'airport.marketshare',
    entityId: cycleId ? `${airportId}:${cycleId}` : airportId,
    before: { entries: before.entries, total: before.total },
    after: { entries: after.entries, total: after.total },
  });
  return after;
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
