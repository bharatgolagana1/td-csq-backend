/**
 * Which customers an operator may sample for a cycle (ARCHITECTURE.md §7
 * "Sampling": ACTIVE, survey type matches the cycle type, BOTH matches
 * either, a BOTH customer in a BOTH cycle yields two entries).
 */
import { cycleSurveyTypes } from '../../cycles/domain/participants.js';
import type { CycleType, SurveyType } from '../../cycles/domain/types.js';

export type CustomerSurveyType = SurveyType | 'BOTH';
export type CustomerStatus = 'ACTIVE' | 'INACTIVE';

/** The customer fields eligibility needs. */
export interface EligibleCustomerLike {
  id: string;
  status: CustomerStatus;
  surveyType: CustomerSurveyType;
}

/** One sampleable (customer, surveyType) pair. */
export interface EligibleEntry<T extends EligibleCustomerLike = EligibleCustomerLike> {
  customer: T;
  surveyType: SurveyType;
  key: string;
}

/** The identity of a sample within a participant: `${customerId}:${surveyType}`. */
export function selectionKey(customerId: string, surveyType: SurveyType): string {
  return `${customerId}:${surveyType}`;
}

/**
 * The survey types a customer of `customerSurveyType` is eligible for in a
 * cycle of `cycleType`, optionally narrowed to the participant's own survey
 * types (an operator without international operations never samples
 * INTERNATIONAL even in a BOTH cycle). DOMESTIC always precedes INTERNATIONAL.
 */
export function eligibleSurveyTypes(
  customerSurveyType: CustomerSurveyType,
  cycleType: CycleType,
  participantSurveyTypes?: readonly SurveyType[],
): SurveyType[] {
  const customerTypes = cycleSurveyTypes(customerSurveyType);
  return cycleSurveyTypes(cycleType).filter(
    (surveyType) =>
      customerTypes.includes(surveyType) &&
      (participantSurveyTypes === undefined || participantSurveyTypes.includes(surveyType)),
  );
}

/**
 * Every (customer, surveyType) entry the operator may select, in input order,
 * DOMESTIC before INTERNATIONAL for a customer that expands into both.
 * Inactive customers are never eligible.
 */
export function eligibleCustomers<T extends EligibleCustomerLike>(
  customers: readonly T[],
  cycleType: CycleType,
  participantSurveyTypes?: readonly SurveyType[],
): EligibleEntry<T>[] {
  const entries: EligibleEntry<T>[] = [];
  for (const customer of customers) {
    if (customer.status !== 'ACTIVE') continue;
    for (const surveyType of eligibleSurveyTypes(customer.surveyType, cycleType, participantSurveyTypes)) {
      entries.push({ customer, surveyType, key: selectionKey(customer.id, surveyType) });
    }
  }
  return entries;
}
