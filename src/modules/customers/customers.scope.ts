// Tenancy for the customer directory (ARCHITECTURE §6 "customers (ACO scope;
// PLATFORM may pass acoId)"). Both services resolve their operator here so
// the rule lives in one place: an ACO sees its own directory only, PLATFORM
// may name any operator, and a cross-tenant id is a 404, never a 403.
import type { Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';
import { idString, toId } from '../../core/ids.js';
import { findOrganisationById } from '../organisations/organisations.service.js';

/** `{ acoId }` for an ACO (or a PLATFORM user naming one); `{}` for PLATFORM reading everything. */
export interface AcoScopeFilter {
  acoId?: Types.ObjectId;
}

function assertNotAirport(ctx: RequestContext): void {
  if (ctx.scope.kind === 'AIRPORT') {
    throw new AppError('FORBIDDEN', 'Customer directories belong to operators');
  }
}

/** The operator whose directory a request reads; an ACO naming another operator gets 404. */
export function customerScopeFilter(ctx: RequestContext, acoId?: string): AcoScopeFilter {
  assertNotAirport(ctx);
  if (ctx.scope.kind === 'ACO') {
    if (acoId !== undefined && acoId !== ctx.scope.acoId) throw new AppError('NOT_FOUND', 'Operator not found');
    return { acoId: toId(ctx.scope.acoId) };
  }
  return acoId === undefined ? {} : { acoId: toId(acoId, 'acoId') };
}

export interface AcoTarget {
  acoId: Types.ObjectId;
  airportId: Types.ObjectId;
}

/** An operator a write targets, with the airport its customers are attached to. */
export async function requireOperatorTarget(acoId: string | Types.ObjectId): Promise<AcoTarget> {
  const org = await findOrganisationById(acoId);
  if (org?.type !== 'ACO') throw new AppError('VALIDATION', 'Unknown operator', { acoId: idString(acoId) });
  if (org.airportId === null) throw new AppError('PRECONDITION_FAILED', 'Operator is not linked to an airport');
  return { acoId: org._id, airportId: org.airportId };
}

/**
 * The operator a create or import writes into: an ACO user's own, or the
 * `acoId` a PLATFORM user must supply.
 */
export async function requireAcoTarget(ctx: RequestContext, acoId?: string): Promise<AcoTarget> {
  const scope = customerScopeFilter(ctx, acoId);
  if (scope.acoId === undefined) throw new AppError('VALIDATION', 'acoId is required for platform users');
  return requireOperatorTarget(scope.acoId);
}
