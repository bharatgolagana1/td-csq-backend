// Invitations prepared but not yet e-mailed (ARCHITECTURE §7 "Cycle clock":
// PENDING at sample lock, sent when the assessment window opens). Until the
// window opens `stats.invited` reads 0 although the operator's sample is
// locked, so the cycle list and monitoring also report what is ready to send.
// The invitations module owns those documents and sits above cycles, so it
// plugs its counter in at boot, as it does the assessment reminder sender;
// until it has, nothing is ready to send.
import { Types, type FilterQuery } from 'mongoose';

import { idString } from '../../core/ids.js';

import type { CycleParticipantDoc } from './cycle-participants.model.js';

/** Whose invitations to count: everyone's, one operator's, or those of the operators at one airport. */
export interface PendingInvitationScope {
  acoId?: string;
  airportId?: string;
}

export interface PendingInvitationCount {
  cycleId: string;
  acoId: string;
  count: number;
}

/** PENDING invitations per cycle and operator, for the given cycles and scope. */
export type PendingInvitationCounter = (cycleIds: readonly string[], scope: PendingInvitationScope) => Promise<PendingInvitationCount[]>;

let counter: PendingInvitationCounter | null = null;

/** Invitations registers its counter here at boot; returns the previous one. */
export function registerPendingInvitationCounter(next: PendingInvitationCounter | null): PendingInvitationCounter | null {
  const previous = counter;
  counter = next;
  return previous;
}

/** The scope of a participant filter (`participantScopeFilter`: `{}`, `{ acoId }` or `{ airportId }`) as plain ids. */
export function pendingScopeOf(participantScope: FilterQuery<CycleParticipantDoc>): PendingInvitationScope {
  const scope: PendingInvitationScope = {};
  const acoId: unknown = participantScope.acoId;
  const airportId: unknown = participantScope.airportId;
  if (acoId instanceof Types.ObjectId) scope.acoId = idString(acoId);
  if (airportId instanceof Types.ObjectId) scope.airportId = idString(airportId);
  return scope;
}

async function countsFor(cycleIds: readonly string[], scope: PendingInvitationScope): Promise<PendingInvitationCount[]> {
  if (counter === null || cycleIds.length === 0) return [];
  return counter(cycleIds, scope);
}

/** Invitations ready to send per cycle (cycle id → count; cycles with none are absent). */
export async function pendingInvitationsByCycle(cycleIds: readonly string[], scope: PendingInvitationScope): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const row of await countsFor(cycleIds, scope)) totals.set(row.cycleId, (totals.get(row.cycleId) ?? 0) + row.count);
  return totals;
}

/** Invitations ready to send per operator of one cycle (aco id → count; operators with none are absent). */
export async function pendingInvitationsByOperator(cycleId: string, scope: PendingInvitationScope): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const row of await countsFor([cycleId], scope)) {
    if (row.cycleId === cycleId) totals.set(row.acoId, (totals.get(row.acoId) ?? 0) + row.count);
  }
  return totals;
}
