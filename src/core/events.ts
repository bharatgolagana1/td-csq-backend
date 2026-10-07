// In-process domain events: how a lower feature triggers work in a higher one
// without importing it (docs/WAVE1-BRIEF.md §2).
//
// `emit` awaits every handler in registration order and propagates the first
// error, so an emitting operation fails as a whole when a listener fails —
// there is no fire-and-forget. When the emitter is inside a transaction it
// passes the session on, and handlers must use it for their own writes.
import type { ClientSession } from 'mongoose';

import type { AnyContext } from './auth/system.js';

export type SurveyType = 'DOMESTIC' | 'INTERNATIONAL';
export type CycleStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'SAMPLING_OPEN'
  | 'SAMPLING_CLOSED'
  | 'ASSESSMENT_OPEN'
  | 'ASSESSMENT_CLOSED'
  | 'SCORED'
  | 'ARCHIVED';

export interface Events {
  'cycle.published': { cycleId: string };
  'cycle.transitioned': { cycleId: string; from: CycleStatus; to: CycleStatus; trigger: 'CLOCK' | 'MANUAL' };
  'sample.locked': {
    cycleId: string;
    acoId: string;
    samples: { sampleId: string; customerId: string; surveyType: SurveyType }[];
  };
  'sample.unlocked': { cycleId: string; acoId: string; reason: string };
  'invitation.sent': { invitationId: string; cycleId: string; acoId: string };
  'assessment.submitted': {
    assessmentId: string;
    cycleId: string;
    acoId: string;
    kind: 'CUSTOMER' | 'SELF';
    surveyType: SurveyType;
    invitationId?: string;
  };
  'scoring.completed': { cycleId: string; provisional: boolean };
}

export interface EventMeta {
  ctx: AnyContext;
  session?: ClientSession;
}

export type EventHandler<K extends keyof Events> = (payload: Events[K], meta: EventMeta) => Promise<void>;

interface Registration {
  event: keyof Events;
  name: string;
  handler: EventHandler<keyof Events>;
}

const registrations: Registration[] = [];

/** Registers a handler. `name` identifies the listener in errors ('invitations.onSampleLocked'). */
export function on<K extends keyof Events>(event: K, name: string, handler: EventHandler<K>): void {
  if (registrations.some((r) => r.event === event && r.name === name)) {
    throw new Error(`Event handler "${name}" is already registered for ${event}`);
  }
  registrations.push({ event, name, handler: handler as EventHandler<keyof Events> });
}

export async function emit<K extends keyof Events>(event: K, payload: Events[K], meta: EventMeta): Promise<void> {
  for (const registration of registrations) {
    if (registration.event !== event) continue;
    try {
      await registration.handler(payload, meta);
    } catch (error) {
      throw new EventHandlerError(event, registration.name, error);
    }
  }
}

export class EventHandlerError extends Error {
  constructor(
    readonly event: keyof Events,
    readonly handlerName: string,
    override readonly cause: unknown,
  ) {
    super(`Handler "${handlerName}" failed for ${event}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'EventHandlerError';
  }
}

/** Names of the handlers registered for an event — for boot logs and tests. */
export function handlersFor(event: keyof Events): string[] {
  return registrations.filter((r) => r.event === event).map((r) => r.name);
}

/** Tests only: forget every handler so a module can be re-registered. */
export function clearEventHandlers(): void {
  registrations.length = 0;
}
