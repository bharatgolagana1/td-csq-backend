// The facts every participant e-mail repeats: who is asking (operator and
// airport), which cycle, and the assessment window in the cycle's time zone.
import type { SurveyType } from '../../core/events.js';
import { findAirportById } from '../airports/airports.service.js';
import { findOrganisationById } from '../organisations/organisations.service.js';

import type { InvitationDoc } from './invitations.model.js';
import type { CycleFacts } from './invitations.peers.js';

export interface OperatorFacts {
  name: string;
  airport: { iata: string; name: string } | null;
}

export async function operatorFacts(acoId: InvitationDoc['acoId']): Promise<OperatorFacts> {
  const operator = await findOrganisationById(acoId);
  if (!operator) return { name: 'your cargo terminal operator', airport: null };
  const airport = operator.airportId ? await findAirportById(operator.airportId) : null;
  return { name: operator.name, airport: airport ? { iata: airport.iata, name: airport.name } : null };
}

export interface MailContext {
  contactName: string;
  customerName: string;
  operatorName: string;
  airportName: string;
  cycleName: string;
  surveyType: string;
  assessmentStart: string;
  assessmentEnd: string;
}

export function surveyTypeLabel(surveyType: SurveyType): string {
  return surveyType === 'DOMESTIC' ? 'Domestic' : 'International';
}

/** `7 October 2026, 09:00 IST` in the cycle's time zone. */
export function formatInstant(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  })
    .format(date)
    .replace(' at ', ', ');
}

/** Whom the e-mail addresses: the contact person, or the company when none is recorded. */
export function contactNameOf(invitation: Pick<InvitationDoc, 'customer'>): string {
  return invitation.customer.contactPerson || invitation.customer.name;
}

export async function mailContext(invitation: InvitationDoc, cycle: CycleFacts): Promise<MailContext> {
  const operator = await operatorFacts(invitation.acoId);
  return {
    contactName: contactNameOf(invitation),
    customerName: invitation.customer.name,
    operatorName: operator.name,
    airportName: operator.airport ? `${operator.airport.name} (${operator.airport.iata})` : '',
    cycleName: cycle.name,
    surveyType: surveyTypeLabel(invitation.surveyType),
    assessmentStart: formatInstant(cycle.assessment.start, cycle.tz),
    assessmentEnd: formatInstant(cycle.assessment.end, cycle.tz),
  };
}
