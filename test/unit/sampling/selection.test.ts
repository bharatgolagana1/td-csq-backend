import { describe, expect, it } from 'vitest';

import type { EligibleCustomerLike } from '../../../src/modules/sampling/domain/eligibility.js';
import { applySelection, type SelectionItem } from '../../../src/modules/sampling/domain/selection.js';

const customers: EligibleCustomerLike[] = [
  { id: 'both', status: 'ACTIVE', surveyType: 'BOTH' },
  { id: 'dom', status: 'ACTIVE', surveyType: 'DOMESTIC' },
  { id: 'intl', status: 'ACTIVE', surveyType: 'INTERNATIONAL' },
  { id: 'gone', status: 'INACTIVE', surveyType: 'BOTH' },
];
const bothCycle = { customers, cycleType: 'BOTH' as const };
const item = (customerId: string, surveyType: SelectionItem['surveyType'] = 'DOMESTIC'): SelectionItem => ({ customerId, surveyType });

describe('applySelection', () => {
  it('adds eligible entries and keeps order: current, then added', () => {
    const result = applySelection({ current: [item('dom')], add: [item('both', 'INTERNATIONAL'), item('both')] }, bothCycle);
    expect(result.selection).toEqual([item('dom'), item('both', 'INTERNATIONAL'), item('both')]);
    expect(result.added).toHaveLength(2);
    expect(result.rejected).toEqual([]);
  });

  it('removes selected entries and reports removes of absent ones', () => {
    const result = applySelection({ current: [item('dom'), item('intl', 'INTERNATIONAL')], remove: [item('dom'), item('both')] }, bothCycle);
    expect(result.selection).toEqual([item('intl', 'INTERNATIONAL')]);
    expect(result.removed).toEqual([item('dom')]);
    expect(result.rejected).toEqual([expect.objectContaining({ customerId: 'both', op: 'remove', reason: 'NOT_SELECTED' })]);
  });

  it('rejects unknown, inactive and wrong-survey-type adds with reasons', () => {
    const result = applySelection(
      {
        current: [],
        add: [item('nobody'), item('gone'), item('intl'), item('dom', 'INTERNATIONAL')],
      },
      bothCycle,
    );
    expect(result.selection).toEqual([]);
    expect(result.rejected.map((r) => [r.customerId, r.reason])).toEqual([
      ['nobody', 'UNKNOWN_CUSTOMER'],
      ['gone', 'INACTIVE_CUSTOMER'],
      ['intl', 'WRONG_SURVEY_TYPE'],
      ['dom', 'WRONG_SURVEY_TYPE'],
    ]);
  });

  it('rejects an INTERNATIONAL add in a DOMESTIC cycle even for a BOTH customer', () => {
    const result = applySelection({ current: [], add: [item('both', 'INTERNATIONAL')] }, { customers, cycleType: 'DOMESTIC' });
    expect(result.rejected[0]?.reason).toBe('WRONG_SURVEY_TYPE');
  });

  it('honours the participant survey types inside a BOTH cycle', () => {
    const result = applySelection(
      { current: [], add: [item('both', 'INTERNATIONAL'), item('both')] },
      { ...bothCycle, participantSurveyTypes: ['DOMESTIC'] },
    );
    expect(result.added).toEqual([item('both')]);
    expect(result.rejected[0]?.reason).toBe('WRONG_SURVEY_TYPE');
  });

  it('rejects an add that is already selected and duplicates inside the request', () => {
    const result = applySelection({ current: [item('dom')], add: [item('dom'), item('both'), item('both')] }, bothCycle);
    expect(result.selection).toEqual([item('dom'), item('both')]);
    expect(result.rejected.map((r) => r.reason)).toEqual(['DUPLICATE_IN_REQUEST', 'ALREADY_SELECTED']);
  });

  it('rejects an item listed in both add and remove, leaving the selection untouched for it', () => {
    const result = applySelection({ current: [item('dom')], add: [item('dom')], remove: [item('dom')] }, bothCycle);
    expect(result.selection).toEqual([item('dom')]);
    expect(result.rejected.map((r) => [r.op, r.reason])).toEqual([
      ['add', 'CONFLICTING'],
      ['remove', 'CONFLICTING'],
    ]);
  });

  it('lets an operator remove a customer that was deactivated after selection', () => {
    const result = applySelection({ current: [item('gone')], remove: [item('gone')] }, bothCycle);
    expect(result.selection).toEqual([]);
    expect(result.removed).toEqual([item('gone')]);
  });

  it('returns the current selection unchanged for an empty request', () => {
    const current = [item('dom'), item('both', 'INTERNATIONAL')];
    const result = applySelection({ current }, bothCycle);
    expect(result).toEqual({ selection: current, added: [], removed: [], rejected: [] });
  });
});
