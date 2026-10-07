// Who may read which report (ARCHITECTURE §7 "Confidentiality"). Cross-tenant
// reads are 404, never 403, so a report URL cannot be used to probe ids.
import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';

import { loadAirport, loadOperator, type AirportView, type OperatorView } from './reports.sources.js';

/** PLATFORM any operator; ACO itself; AIRPORT the operators at its airport (mirrors `operatorScopeFilter`). */
function operatorVisible(ctx: RequestContext, operator: OperatorView): boolean {
  switch (ctx.scope.kind) {
    case 'PLATFORM':
      return true;
    case 'ACO':
      return ctx.scope.acoId === operator.id;
    case 'AIRPORT':
      return operator.airportId === ctx.scope.airportId;
  }
}

/** PLATFORM any airport; AIRPORT its own; ACO the airport it operates at (mirrors the market-share rule). */
function airportVisible(ctx: RequestContext, airportId: string): boolean {
  switch (ctx.scope.kind) {
    case 'PLATFORM':
      return true;
    case 'ACO':
      return ctx.org.airportId === airportId;
    case 'AIRPORT':
      return ctx.scope.airportId === airportId;
  }
}

export async function requireVisibleOperator(ctx: RequestContext, acoId: string): Promise<OperatorView> {
  const operator = await loadOperator(acoId);
  if (!operator || !operatorVisible(ctx, operator)) throw new AppError('NOT_FOUND', 'Operator not found');
  return operator;
}

export async function requireVisibleAirport(ctx: RequestContext, airportId: string): Promise<AirportView> {
  const airport = await loadAirport(airportId);
  if (!airport || !airportVisible(ctx, airportId)) throw new AppError('NOT_FOUND', 'Airport not found');
  return airport;
}

/** Per-operator figures inside an airport report are for platform and airport roles only. */
export function seesOperatorFigures(ctx: RequestContext): boolean {
  return ctx.scope.kind === 'PLATFORM' || ctx.scope.kind === 'AIRPORT';
}
