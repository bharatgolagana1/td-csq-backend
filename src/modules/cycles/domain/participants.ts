/**
 * Which survey types a participating operator takes part in, and how many
 * samples it owes (ARCHITECTURE.md §5 `cycle_participants`, REQUIREMENTS §11–13).
 */
import type { CycleType, SurveyType } from './types.js';

/** `organisations.operations` of an ACO. */
export interface OperatorOperations {
  domestic: boolean;
  international: boolean;
}

/** The survey types a cycle of `cycleType` runs. */
export function cycleSurveyTypes(cycleType: CycleType): SurveyType[] {
  switch (cycleType) {
    case 'DOMESTIC':
      return ['DOMESTIC'];
    case 'INTERNATIONAL':
      return ['INTERNATIONAL'];
    case 'BOTH':
      return ['DOMESTIC', 'INTERNATIONAL'];
  }
}

/**
 * The survey types an operator participates in: the cycle's types restricted
 * to the operations the operator actually runs. Empty when the operator has
 * nothing to assess in this cycle (it should not become a participant).
 */
export function participantSurveyTypes(cycleType: CycleType, operations: OperatorOperations): SurveyType[] {
  return cycleSurveyTypes(cycleType).filter((surveyType) =>
    surveyType === 'DOMESTIC' ? operations.domestic : operations.international,
  );
}

export function isEligibleParticipant(cycleType: CycleType, operations: OperatorOperations): boolean {
  return participantSurveyTypes(cycleType, operations).length > 0;
}

/**
 * Samples the participant must select before it may lock. The minimum is a
 * flat count of (customer, surveyType) entries per operator, not per survey
 * type; an operator with no applicable survey type owes nothing.
 */
export function requiredSampleSize(
  cycle: { minSampleSize: number },
  participantTypes: readonly SurveyType[],
): number {
  if (!Number.isInteger(cycle.minSampleSize) || cycle.minSampleSize < 0) {
    throw new RangeError(`minSampleSize must be a whole number ≥ 0 (got ${cycle.minSampleSize})`);
  }
  return participantTypes.length === 0 ? 0 : cycle.minSampleSize;
}
