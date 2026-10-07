// `GET /cycles/:id/monitoring` (REQUIREMENTS §24): sampling and assessment
// totals composed from cycle_participants, then Airport → ACO drill-down.
// Scoped like participants: PLATFORM everything, AIRPORT its airport, ACO itself.
import type { RequestContext } from '../../core/auth/session.js';
import { idString } from '../../core/ids.js';
import { findAirportsByIds } from '../airports/airports.service.js';
import { findOrganisationsByIds } from '../organisations/organisations.service.js';

import type { CycleParticipantDoc } from './cycle-participants.model.js';
import type { MonitoringDto } from './cycles.schemas.js';
import { requireVisibleCycle } from './cycles.service.js';
import { listParticipantDocs, participantScopeFilter } from './participants.service.js';

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export async function getMonitoring(ctx: RequestContext, cycleId: string): Promise<MonitoringDto> {
  const cycle = await requireVisibleCycle(ctx, cycleId);
  const participants = await listParticipantDocs(cycle._id, participantScopeFilter(ctx));
  const airportIds =
    ctx.scope.kind === 'PLATFORM'
      ? cycle.participatingAirportIds.map(idString)
      : [...new Set(participants.map((participant) => idString(participant.airportId)))];
  const [airports, operators] = await Promise.all([
    findAirportsByIds(airportIds),
    findOrganisationsByIds(participants.map((participant) => participant.acoId)),
  ]);

  const locked = participants.filter((participant) => participant.sampling.status === 'LOCKED');
  const invited = sum(participants.map((participant) => participant.stats.invited));
  const started = sum(participants.map((participant) => participant.stats.started));
  const completed = sum(participants.map((participant) => participant.stats.completed));

  const byAirport = airportIds.map((airportId) => {
    const airport = airports.get(airportId);
    const here = participants.filter((participant) => idString(participant.airportId) === airportId);
    return {
      airportId,
      iata: airport?.iata ?? '?',
      name: airport?.name ?? 'Unknown airport',
      operators: here.map((participant: CycleParticipantDoc) => {
        const operator = operators.get(idString(participant.acoId));
        return {
          acoId: idString(participant.acoId),
          code: operator?.code ?? '?',
          name: operator?.name ?? 'Unknown operator',
          sampling: {
            status: participant.sampling.status,
            selectedCount: participant.sampling.selectedCount,
            required: participant.requiredSampleSize,
          },
          invited: participant.stats.invited,
          started: participant.stats.started,
          completed: participant.stats.completed,
        };
      }),
    };
  });

  return {
    cycleId: idString(cycle._id),
    status: cycle.status,
    sampling: {
      airports: airportIds.length,
      operators: participants.length,
      sampleRequired: sum(participants.map((participant) => participant.requiredSampleSize)),
      sampleLocked: sum(locked.map((participant) => participant.sampling.selectedCount)),
      lockedOperators: locked.length,
    },
    assessment: {
      invited,
      started,
      completed,
      pending: Math.max(0, invited - completed),
      completionRate: invited === 0 ? 0 : Math.round((completed / invited) * 1000) / 10,
    },
    byAirport,
  };
}
