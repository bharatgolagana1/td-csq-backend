import { describe, expect, it } from 'vitest';

import {
  eligibleCustomers,
  eligibleSurveyTypes,
  selectionKey,
  type EligibleCustomerLike,
} from '../../../src/modules/sampling/domain/eligibility.js';

const customers: EligibleCustomerLike[] = [
  { id: 'c-both', status: 'ACTIVE', surveyType: 'BOTH' },
  { id: 'c-dom', status: 'ACTIVE', surveyType: 'DOMESTIC' },
  { id: 'c-intl', status: 'ACTIVE', surveyType: 'INTERNATIONAL' },
  { id: 'c-inactive', status: 'INACTIVE', surveyType: 'BOTH' },
];

describe('eligibleSurveyTypes', () => {
  it('BOTH matches either cycle type; a single type matches only its own', () => {
    expect(eligibleSurveyTypes('BOTH', 'DOMESTIC')).toEqual(['DOMESTIC']);
    expect(eligibleSurveyTypes('BOTH', 'INTERNATIONAL')).toEqual(['INTERNATIONAL']);
    expect(eligibleSurveyTypes('BOTH', 'BOTH')).toEqual(['DOMESTIC', 'INTERNATIONAL']);
    expect(eligibleSurveyTypes('DOMESTIC', 'INTERNATIONAL')).toEqual([]);
    expect(eligibleSurveyTypes('INTERNATIONAL', 'BOTH')).toEqual(['INTERNATIONAL']);
  });

  it('is narrowed by the participant survey types', () => {
    expect(eligibleSurveyTypes('BOTH', 'BOTH', ['DOMESTIC'])).toEqual(['DOMESTIC']);
    expect(eligibleSurveyTypes('INTERNATIONAL', 'BOTH', ['DOMESTIC'])).toEqual([]);
  });
});

describe('eligibleCustomers', () => {
  it('expands a BOTH customer into two entries in a BOTH cycle, DOMESTIC first', () => {
    const entries = eligibleCustomers(customers, 'BOTH');
    expect(entries.map((entry) => entry.key)).toEqual([
      'c-both:DOMESTIC',
      'c-both:INTERNATIONAL',
      'c-dom:DOMESTIC',
      'c-intl:INTERNATIONAL',
    ]);
    expect(entries[0]?.customer).toBe(customers[0]);
  });

  it('yields one entry per customer in a single-type cycle and skips mismatches', () => {
    expect(eligibleCustomers(customers, 'DOMESTIC').map((entry) => entry.key)).toEqual(['c-both:DOMESTIC', 'c-dom:DOMESTIC']);
    expect(eligibleCustomers(customers, 'INTERNATIONAL').map((entry) => entry.key)).toEqual([
      'c-both:INTERNATIONAL',
      'c-intl:INTERNATIONAL',
    ]);
  });

  it('never includes inactive customers', () => {
    expect(eligibleCustomers(customers, 'BOTH').some((entry) => entry.customer.id === 'c-inactive')).toBe(false);
  });

  it('respects a domestic-only participant inside a BOTH cycle', () => {
    expect(eligibleCustomers(customers, 'BOTH', ['DOMESTIC']).map((entry) => entry.key)).toEqual([
      'c-both:DOMESTIC',
      'c-dom:DOMESTIC',
    ]);
  });

  it('returns nothing for an empty directory', () => {
    expect(eligibleCustomers([], 'BOTH')).toEqual([]);
  });
});

describe('selectionKey', () => {
  it('joins customer id and survey type', () => {
    expect(selectionKey('abc', 'INTERNATIONAL')).toBe('abc:INTERNATIONAL');
  });
});
