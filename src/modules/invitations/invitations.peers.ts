// What invitations needs from its neighbours (WAVE1-BRIEF §2): cycles and
// customers below it, and assessments, which the public participant flow
// delegates to. Their services are imported only here and their results are
// reduced to the few fields invitations reads, so a neighbour's DTO can change
// shape — `id` or `_id`, `{ wall, utc }` or a plain instant — without touching
// the rest of this module, and tests can stand the whole boundary in.
import { Types } from 'mongoose';
import { z } from 'zod';

import type { LinkSession } from '../../core/auth/link.js';
import type { AnyContext } from '../../core/auth/system.js';
import { AppError } from '../../core/errors.js';
import type {
  AssessmentDto,
  AssessmentFormDto,
  DraftDto,
  PatchAnswersInput,
  PatchAnswersResult,
  ReadinessDto,
} from '../assessments/assessments.schemas.js';
import { getDraft, getForm, getOrCreateForInvitation, patchAnswers, readiness, submit } from '../assessments/assessments.service.js';
import { getCustomer } from '../customers/customers.service.js';
import { bumpParticipantStats, getCycle, getParticipant } from '../cycles/cycles.service.js';
import { CYCLE_STATUSES, CYCLE_TYPES, type CycleStatus, type CycleType, type ReminderPolicy } from '../cycles/domain/types.js';

import { CUSTOMER_TYPES, type CustomerType, type InvitationDoc } from './invitations.model.js';

export interface CycleFacts {
  id: string;
  name: string;
  code: string;
  type: CycleType;
  status: CycleStatus;
  tz: string;
  assessment: { start: Date; end: Date };
  reminders: { assessment: ReminderPolicy };
}

export interface ParticipantFacts {
  airportId: string | null;
  samplingStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'LOCKED' | 'UNLOCKED';
}

export interface CustomerFacts {
  id: string;
  name: string;
  contactPerson: string;
  email: string;
  type: CustomerType;
}

// --- normalisers ------------------------------------------------------------

const idLike = z.union([
  z.string().regex(/^[0-9a-fA-F]{24}$/),
  z.instanceof(Types.ObjectId).transform((value) => value.toHexString()),
]);

const isoDate = z.string().transform((value, ctx) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: 'custom', message: `invalid date "${value}"` });
    return z.NEVER;
  }
  return date;
});

const instantLike = z.union([
  z.date(),
  isoDate,
  z.object({ utc: z.union([z.date(), isoDate]) }).transform((edge) => edge.utc),
]);

const reminderPolicy = z.object({ count: z.number().int().min(0), everyDays: z.number().int().min(0) });

const cycleSchema = z
  .object({
    id: idLike.optional(),
    _id: idLike.optional(),
    name: z.string(),
    code: z.string().default(''),
    type: z.enum(CYCLE_TYPES),
    status: z.enum(CYCLE_STATUSES),
    tz: z.string().min(1),
    assessment: z.object({ start: instantLike, end: instantLike }),
    reminders: z.object({ assessment: reminderPolicy }),
  })
  .transform((cycle, ctx): CycleFacts => {
    const id = cycle.id ?? cycle._id;
    if (id === undefined) {
      ctx.addIssue({ code: 'custom', message: 'cycle without id' });
      return z.NEVER;
    }
    return {
      id,
      name: cycle.name,
      code: cycle.code,
      type: cycle.type,
      status: cycle.status,
      tz: cycle.tz,
      assessment: cycle.assessment,
      reminders: { assessment: cycle.reminders.assessment },
    };
  });

const participantSchema = z
  .object({
    airportId: idLike.nullable().optional(),
    sampling: z.object({ status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'LOCKED', 'UNLOCKED']) }),
  })
  .transform((participant): ParticipantFacts => ({
    airportId: participant.airportId ?? null,
    samplingStatus: participant.sampling.status,
  }));

const customerSchema = z
  .object({
    id: idLike.optional(),
    _id: idLike.optional(),
    name: z.string(),
    contactPerson: z.string().default(''),
    email: z.email(),
    type: z.enum(CUSTOMER_TYPES),
  })
  .transform((customer, ctx): CustomerFacts => {
    const id = customer.id ?? customer._id;
    if (id === undefined) {
      ctx.addIssue({ code: 'custom', message: 'customer without id' });
      return z.NEVER;
    }
    return { id, name: customer.name, contactPerson: customer.contactPerson, email: customer.email, type: customer.type };
  });

const assessmentRefSchema = z
  .object({ id: idLike.optional(), _id: idLike.optional() })
  .transform((assessment, ctx): string => {
    const id = assessment.id ?? assessment._id;
    if (id === undefined) {
      ctx.addIssue({ code: 'custom', message: 'assessment without id' });
      return z.NEVER;
    }
    return id;
  });

function parsePeer<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError('INTERNAL', `Unexpected ${what} shape from its module`, {
    issues: result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  });
}

/** Runs a lookup and turns its NOT_FOUND (thrown or returned as null) into null. */
async function lookup(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    const value = await fn();
    return value ?? null;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

// --- cycles ------------------------------------------------------------------

export async function cycleFacts(ctx: AnyContext, cycleId: string): Promise<CycleFacts | null> {
  const raw = await lookup(() => getCycle(ctx, cycleId));
  return raw === null ? null : parsePeer(cycleSchema, raw, 'cycle');
}

export async function participantFacts(cycleId: string, acoId: string): Promise<ParticipantFacts | null> {
  const raw = await lookup(() => getParticipant(cycleId, acoId));
  return raw === null ? null : parsePeer(participantSchema, raw, 'participant');
}

/** `cycle_participants.stats.started`: counted when a participant first verifies. */
export async function bumpStarted(cycleId: string, acoId: string): Promise<void> {
  await bumpParticipantStats(cycleId, acoId, 'started', 1);
}

// --- customers ---------------------------------------------------------------

export async function customerFacts(acoId: string, customerId: string): Promise<CustomerFacts | null> {
  const raw = await lookup(() => getCustomer(acoId, customerId));
  return raw === null ? null : parsePeer(customerSchema, raw, 'customer');
}

// --- assessments -------------------------------------------------------------

/** The assessment behind an invitation (one invitation ⇒ one assessment); returns its id. */
export async function getOrCreateAssessment(invitation: InvitationDoc): Promise<string> {
  return parsePeer(assessmentRefSchema, await getOrCreateForInvitation(invitation), 'assessment');
}

export function assessmentForm(assessmentId: string): Promise<AssessmentFormDto> {
  return getForm(assessmentId);
}

export function assessmentDraft(assessmentId: string): Promise<DraftDto> {
  return getDraft(assessmentId);
}

export function patchAssessmentAnswers(assessmentId: string, answers: PatchAnswersInput['answers']): Promise<PatchAnswersResult> {
  return patchAnswers(assessmentId, answers);
}

export function assessmentReadiness(assessmentId: string): Promise<ReadinessDto> {
  return readiness(assessmentId);
}

/** Locks the assessment; assessments emits `assessment.submitted`, which this module answers with SUBMITTED + thank-you. */
export function submitAssessment(link: LinkSession, assessmentId: string): Promise<AssessmentDto> {
  return submit(link, assessmentId);
}
