// Where an assessment's cycle, participant, customer and form come from: the
// lower modules' exported service functions (WAVE1-BRIEF §2), reduced to the
// few fields assessments need so the rest of the module never sees their
// document shapes.
import type { AnyContext } from '../../core/auth/system.js';
import { AppError } from '../../core/errors.js';
import type { CycleStatus, SurveyType } from '../../core/events.js';
import { idString } from '../../core/ids.js';
import { getCustomer } from '../customers/customers.service.js';
import { getCycle, getParticipant } from '../cycles/cycles.service.js';
import { getFormForStakeholder, getSurveyTree } from '../surveys/surveys.service.js';

import { formFromStakeholderForm, formFromTree, type AssessmentForm } from './assessments.form.js';
import type { CustomerType } from './assessments.model.js';

export interface CycleRef {
  id: string;
  code: string;
  name: string;
  status: CycleStatus;
  /** Survey version pinned per survey type at publish. */
  surveyVersions: Partial<Record<SurveyType, string | null>>;
}

export interface ParticipantRef {
  airportId: string;
  surveyTypes: SurveyType[];
}

export interface CustomerRef {
  id: string;
  name: string;
  contactPerson: string | null;
  email: string;
  type: CustomerType;
}

function nullOnNotFound(error: unknown): null {
  if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
  throw error;
}

/** The cycle as the caller may see it (cycles scopes it; a cycle out of scope is a 404 there). */
export async function cycleRef(ctx: AnyContext, cycleId: string): Promise<CycleRef> {
  const cycle = await getCycle(ctx, cycleId);
  return {
    id: idString(cycle.id),
    code: cycle.code,
    name: cycle.name,
    status: cycle.status,
    surveyVersions: {
      ...(cycle.surveyVersions.DOMESTIC ? { DOMESTIC: idString(cycle.surveyVersions.DOMESTIC) } : {}),
      ...(cycle.surveyVersions.INTERNATIONAL ? { INTERNATIONAL: idString(cycle.surveyVersions.INTERNATIONAL) } : {}),
    },
  };
}

export async function participantRef(cycleId: string, acoId: string): Promise<ParticipantRef | null> {
  const participant = await getParticipant(cycleId, acoId).catch(nullOnNotFound);
  if (!participant) return null;
  return { airportId: idString(participant.airportId), surveyTypes: [...participant.surveyTypes] };
}

export async function customerRef(acoId: string, customerId: string): Promise<CustomerRef | null> {
  const customer = await getCustomer(acoId, customerId).catch(nullOnNotFound);
  if (!customer) return null;
  return { id: customer.id, name: customer.name, contactPerson: customer.contactPerson, email: customer.email, type: customer.type };
}

/** The form a customer of `type` fills in: the surveys module's stakeholder form (active questions aimed at that type, ordered). */
export async function customerForm(surveyId: string, type: CustomerType): Promise<AssessmentForm> {
  return formFromStakeholderForm(await getFormForStakeholder(surveyId, type));
}

/** The self-assessment form: every active question of the survey version. */
export async function selfForm(surveyId: string): Promise<AssessmentForm> {
  return formFromTree(await getSurveyTree(surveyId));
}
