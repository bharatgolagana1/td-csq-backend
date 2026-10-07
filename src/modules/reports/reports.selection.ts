// Which cycle and survey type a report is about when the caller does not say:
// the latest SCORED cycle the subject took part in, else the current (live)
// one with figures flagged provisional. An explicit `cycleId` must be visible
// to the caller and must include the subject, else 404.
import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';

import { isLive, isScored, surveyTypesOfCycle } from './reports.figures.js';
import type { SurveyType } from './reports.schemas.js';
import {
  loadCycle,
  loadCycleRefs,
  loadParticipant,
  loadParticipants,
  type CycleFilter,
  type CycleRef,
  type CycleView,
  type ParticipantView,
} from './reports.sources.js';

export interface ReportSelection {
  cycle: CycleView;
  surveyType: SurveyType;
  provisional: boolean;
}

export interface OperatorSelection extends ReportSelection {
  participant: ParticipantView;
}

export interface AirportSelection extends ReportSelection {
  /** The cycle's participants at this airport. */
  participants: ParticipantView[];
}

interface SelectionQuery {
  cycleId?: string | undefined;
  surveyType?: string | undefined;
}

async function requireCycle(ctx: RequestContext, cycleId: string): Promise<CycleView> {
  const cycle = await loadCycle(ctx, cycleId);
  if (!cycle) throw new AppError('NOT_FOUND', 'Cycle not found');
  return cycle;
}

/** Scored cycles by `scoredAt` (newest first), live ones by assessment start; `createdAt` breaks ties. */
function newestFirst(a: CycleRef, b: CycleRef): number {
  const at = (cycle: CycleRef): number => (cycle.scoredAt ?? cycle.assessment?.start ?? cycle.createdAt).getTime();
  return at(b) - at(a) || b.createdAt.getTime() - a.createdAt.getTime();
}

/**
 * Newest scored cycle for which `membership` finds the subject, else the
 * newest live one; `null` when there is none. Returns what `membership` found
 * so the caller does not look it up twice.
 */
async function pickDefaultCycle<T>(
  ctx: RequestContext,
  filter: CycleFilter,
  membership: (cycle: CycleRef) => Promise<T | null>,
): Promise<{ cycle: CycleView; member: T } | null> {
  const cycles = (await loadCycleRefs(ctx, filter)).sort(newestFirst);
  for (const eligible of [isScored, isLive]) {
    for (const ref of cycles) {
      if (!eligible(ref)) continue;
      const member = await membership(ref);
      if (member === null) continue;
      const cycle = await loadCycle(ctx, ref.id);
      if (cycle) return { cycle, member };
    }
  }
  return null;
}

function chooseSurveyType(offered: readonly SurveyType[], requested: string | undefined, subject: string): SurveyType {
  const first = offered[0];
  if (!first) throw new AppError('NOT_FOUND', `${subject} has nothing to assess in this cycle`);
  if (requested === undefined) return first;
  const match = offered.find((type) => type === requested);
  if (!match) throw new AppError('NOT_FOUND', `${subject} did not take part in the ${requested} survey of this cycle`);
  return match;
}

export async function selectOperatorCycle(ctx: RequestContext, acoId: string, query: SelectionQuery): Promise<OperatorSelection> {
  const participantIn = (cycle: CycleRef): Promise<ParticipantView | null> => loadParticipant(cycle.id, acoId);
  let found: { cycle: CycleView; member: ParticipantView } | null = null;
  if (query.cycleId !== undefined) {
    const cycle = await requireCycle(ctx, query.cycleId);
    const participant = await participantIn(cycle);
    if (participant) found = { cycle, member: participant };
  } else {
    found = await pickDefaultCycle(ctx, { acoId }, participantIn);
  }
  if (!found) throw new AppError('NOT_FOUND', 'Operator did not take part in this cycle');
  return {
    cycle: found.cycle,
    participant: found.member,
    surveyType: chooseSurveyType(found.member.surveyTypes, query.surveyType, 'Operator'),
    provisional: !isScored(found.cycle),
  };
}

/** The participants at the airport, or `null` when it has none in the cycle. */
async function participantsAt(cycleId: string, airportId: string): Promise<ParticipantView[] | null> {
  const participants = (await loadParticipants(cycleId)).filter((participant) => participant.airportId === airportId);
  return participants.length > 0 ? participants : null;
}

export async function selectAirportCycle(ctx: RequestContext, airportId: string, query: SelectionQuery): Promise<AirportSelection> {
  const membersAt = (cycle: CycleRef): Promise<ParticipantView[] | null> => participantsAt(cycle.id, airportId);
  let found: { cycle: CycleView; member: ParticipantView[] } | null = null;
  if (query.cycleId !== undefined) {
    const cycle = await requireCycle(ctx, query.cycleId);
    const participants = await membersAt(cycle);
    if (participants) found = { cycle, member: participants };
  } else {
    found = await pickDefaultCycle(ctx, { airportId }, membersAt);
  }
  if (!found) throw new AppError('NOT_FOUND', 'Airport did not take part in this cycle');
  return {
    cycle: found.cycle,
    participants: found.member,
    surveyType: chooseSurveyType(surveyTypesOfCycle(found.cycle.type), query.surveyType, 'Airport'),
    provisional: !isScored(found.cycle),
  };
}

export async function selectNationalCycle(ctx: RequestContext, query: SelectionQuery): Promise<ReportSelection> {
  const cycle =
    query.cycleId !== undefined
      ? await requireCycle(ctx, query.cycleId)
      : ((await pickDefaultCycle(ctx, {}, async () => true))?.cycle ?? null);
  if (!cycle) throw new AppError('NOT_FOUND', 'No cycle to report on');
  return {
    cycle,
    surveyType: chooseSurveyType(surveyTypesOfCycle(cycle.type), query.surveyType, 'The cycle'),
    provisional: !isScored(cycle),
  };
}
