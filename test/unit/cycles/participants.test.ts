import { describe, expect, it } from 'vitest';

import {
  cycleSurveyTypes,
  isEligibleParticipant,
  participantSurveyTypes,
  requiredSampleSize,
} from '../../../src/modules/cycles/domain/participants.js';

const both = { domestic: true, international: true };
const domesticOnly = { domestic: true, international: false };
const internationalOnly = { domestic: false, international: true };
const none = { domestic: false, international: false };

describe('cycleSurveyTypes', () => {
  it('expands BOTH into the two survey types, DOMESTIC first', () => {
    expect(cycleSurveyTypes('DOMESTIC')).toEqual(['DOMESTIC']);
    expect(cycleSurveyTypes('INTERNATIONAL')).toEqual(['INTERNATIONAL']);
    expect(cycleSurveyTypes('BOTH')).toEqual(['DOMESTIC', 'INTERNATIONAL']);
  });
});

describe('participantSurveyTypes', () => {
  it('intersects the cycle type with the operations the operator runs', () => {
    expect(participantSurveyTypes('BOTH', both)).toEqual(['DOMESTIC', 'INTERNATIONAL']);
    expect(participantSurveyTypes('BOTH', domesticOnly)).toEqual(['DOMESTIC']);
    expect(participantSurveyTypes('BOTH', internationalOnly)).toEqual(['INTERNATIONAL']);
    expect(participantSurveyTypes('DOMESTIC', both)).toEqual(['DOMESTIC']);
    expect(participantSurveyTypes('DOMESTIC', internationalOnly)).toEqual([]);
    expect(participantSurveyTypes('INTERNATIONAL', domesticOnly)).toEqual([]);
    expect(participantSurveyTypes('BOTH', none)).toEqual([]);
  });

  it('isEligibleParticipant is "at least one survey type"', () => {
    expect(isEligibleParticipant('INTERNATIONAL', internationalOnly)).toBe(true);
    expect(isEligibleParticipant('INTERNATIONAL', domesticOnly)).toBe(false);
  });
});

describe('requiredSampleSize', () => {
  it('is the cycle minimum as a flat count, whatever the survey types', () => {
    expect(requiredSampleSize({ minSampleSize: 50 }, ['DOMESTIC'])).toBe(50);
    expect(requiredSampleSize({ minSampleSize: 50 }, ['DOMESTIC', 'INTERNATIONAL'])).toBe(50);
  });

  it('is zero for an operator with nothing to assess', () => {
    expect(requiredSampleSize({ minSampleSize: 50 }, [])).toBe(0);
  });

  it('rejects a negative or fractional minimum', () => {
    expect(() => requiredSampleSize({ minSampleSize: -1 }, ['DOMESTIC'])).toThrow(RangeError);
    expect(() => requiredSampleSize({ minSampleSize: 2.5 }, ['DOMESTIC'])).toThrow(RangeError);
  });
});
