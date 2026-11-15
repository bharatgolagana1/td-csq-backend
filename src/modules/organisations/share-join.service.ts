// An operator joining an airport — created by ACFI (POST /operators) or
// approved from a registration — changes the airport's market-share set. The
// joining operator's share and the shares of every operator already ACTIVE
// there are written together as one current set that totals 100, so the
// airport never drifts away from 100 and the next cycle there can publish.
import type { ClientSession, Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';
import { idString, toId } from '../../core/ids.js';
import { findAirportById } from '../airports/airports.service.js';

import { currentShareView, roundShare, totalsHundred, writeShareSet, type ShareChange } from './market-share.service.js';
import { MarketShareModel, type MarketShareDoc } from './market-shares.model.js';
import { OrganisationModel, type OrganisationDoc } from './organisations.model.js';
import type { JoiningSharesInput } from './organisations.schemas.js';
import { findOrganisationsByIds } from './organisations.service.js';

/** One ACTIVE operator at an airport with its current (cycle-less) share; 0 when none is set. */
export interface OperatorShare {
  acoId: string;
  code: string;
  name: string;
  sharePct: number;
}

/** The ACTIVE operators at an airport with their current shares, by name. */
export async function activeOperatorShares(airportId: string | Types.ObjectId, session?: ClientSession): Promise<OperatorShare[]> {
  const airportOid = toId(idString(airportId), 'airportId');
  const options = session ? { session } : {};
  const operators = await OrganisationModel.find({ type: 'ACO', status: 'ACTIVE', airportId: airportOid }, null, options)
    .sort({ name: 1 })
    .lean<OrganisationDoc[]>();
  const shares = await MarketShareModel.find({ airportId: airportOid, cycleId: null, acoId: { $in: operators.map((org) => org._id) } }, null, options).lean<
    MarketShareDoc[]
  >();
  const shareByAco = new Map(shares.map((doc) => [idString(doc.acoId), doc.sharePct]));
  return operators.map((org) => ({ acoId: idString(org._id), code: org.code, name: org.name, sharePct: shareByAco.get(idString(org._id)) ?? 0 }));
}

export interface JoiningShareRequest {
  airportId: string;
  /** The joining operator's code, for messages (it does not exist yet). */
  code: string;
  /** Its share; omitted counts as 0. */
  sharePct: number | undefined;
  /** Shares for the operators already ACTIVE at the airport; omitted keeps their current shares. */
  others: JoiningSharesInput | undefined;
}

/** A validated set: the joining operator's share and one entry per operator already ACTIVE at the airport. */
export interface JoiningSharePlan {
  airportId: string;
  code: string;
  sharePct: number;
  others: { acoId: string; sharePct: number }[];
}

interface Issue {
  path: string;
  message: string;
}

/** `others` must name every ACTIVE operator at the airport exactly once, and nobody else. */
async function checkOthers(given: JoiningSharesInput, active: OperatorShare[], where: string, issues: Issue[]): Promise<void> {
  const activeById = new Map(active.map((operator) => [operator.acoId, operator]));
  const strangers = await findOrganisationsByIds(given.filter((entry) => !activeById.has(entry.acoId)).map((entry) => entry.acoId));
  const seen = new Set<string>();
  given.forEach((entry, index) => {
    const path = `shares.${index}.acoId`;
    const operator = activeById.get(entry.acoId);
    if (!operator) {
      const org = strangers.get(entry.acoId);
      if (org?.type !== 'ACO') issues.push({ path, message: `Unknown operator ${entry.acoId}` });
      else if (org.status !== 'ACTIVE') issues.push({ path, message: `Operator ${org.code} is ${org.status}; only active operators hold a share` });
      else issues.push({ path, message: `Operator ${org.code} does not operate at ${where}` });
    } else if (seen.has(entry.acoId)) {
      issues.push({ path, message: `Operator ${operator.code} is listed twice` });
    }
    seen.add(entry.acoId);
  });
  for (const operator of active) {
    if (!seen.has(operator.acoId)) issues.push({ path: 'shares', message: `No share given for ${operator.code} (${operator.name}), active at ${where}` });
  }
}

/** The total must be 100 ± SHARE_TOLERANCE; the message says which part is which. */
function totalIssue(request: JoiningShareRequest, others: { sharePct: number }[], where: string): Issue | null {
  const sharePct = request.sharePct ?? 0;
  const othersTotal = roundShare(others.reduce((sum, entry) => sum + entry.sharePct, 0));
  const total = roundShare(othersTotal + sharePct);
  if (totalsHundred(total)) return null;
  if (others.length === 0) {
    return { path: 'marketSharePct', message: `${request.code} is the only active operator at ${where}, so its share must be 100 (got ${sharePct})` };
  }
  const count = `${others.length} active operator${others.length === 1 ? '' : 's'}`;
  return {
    path: request.others === undefined ? 'marketSharePct' : 'shares',
    message: `Market shares at ${where} must total 100 (got ${total}: ${othersTotal} for the ${count} + ${sharePct} for ${request.code})`,
  };
}

/**
 * Validates the airport's whole current set once an operator joins: when
 * `others` is given it names every operator ACTIVE there exactly once, and
 * with the joining operator's share the set totals 100 ± SHARE_TOLERANCE — a
 * sole operator therefore holds 100. VALIDATION issues name the request
 * fields POST /operators and the registration approval share: `shares.N.acoId`,
 * `shares` and `marketSharePct`.
 */
export async function planJoiningShares(request: JoiningShareRequest): Promise<JoiningSharePlan> {
  const [airport, active] = await Promise.all([findAirportById(request.airportId), activeOperatorShares(request.airportId)]);
  const where = airport?.iata ?? request.airportId;
  const issues: Issue[] = [];
  if (request.others !== undefined) await checkOthers(request.others, active, where, issues);
  const others = request.others ?? active.map(({ acoId, sharePct }) => ({ acoId, sharePct }));
  if (issues.length === 0) {
    const total = totalIssue(request, others, where);
    if (total) issues.push(total);
  }
  if (issues.length > 0) throw new AppError('VALIDATION', `Market shares at ${where} must total 100 with ${request.code}`, { issues });
  return { airportId: request.airportId, code: request.code, sharePct: request.sharePct ?? 0, others };
}

/**
 * Writes a plan inside the caller's transaction once the joining operator
 * exists (`acoId`, ACTIVE in that transaction): the airport's current set
 * becomes exactly its active operators, the new one included; entries of
 * operators no longer active there are dropped. 409 when the active operators
 * changed since the plan was made. Returns the change; the caller audits it
 * with `auditShareChange` after the commit.
 */
export async function applyJoiningShares(ctx: RequestContext, plan: JoiningSharePlan, acoId: Types.ObjectId, session: ClientSession): Promise<ShareChange> {
  const airportOid = toId(plan.airportId, 'airportId');
  const active = await activeOperatorShares(airportOid, session);
  const planned = new Set([...plan.others.map((entry) => entry.acoId), idString(acoId)]);
  if (active.length !== planned.size || active.some((operator) => !planned.has(operator.acoId))) {
    throw new AppError('CONFLICT', 'The active operators at this airport changed meanwhile; reload the shares and try again', { airportId: plan.airportId });
  }
  const before = await currentShareView(airportOid, session);
  await writeShareSet(
    {
      airportId: airportOid,
      cycleId: null,
      entries: [...plan.others, { acoId: idString(acoId), sharePct: plan.sharePct }],
      setBy: toId(ctx.user.id),
      note: `Set when ${plan.code} joined`,
    },
    session,
  );
  const after = await currentShareView(airportOid, session);
  return { airportId: plan.airportId, cycleId: null, before, after };
}
