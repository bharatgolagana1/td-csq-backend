/**
 * Pure application of a `{ add, remove }` request onto a participant's
 * selection (ARCHITECTURE.md §6 `PUT /sampling/cycles/:cycleId/selection`).
 * Validation happens here; persistence (and the "sampling open, not locked"
 * guard) is the service's job.
 */
import type { CycleType, SurveyType } from '../../cycles/domain/types.js';

import { eligibleSurveyTypes, selectionKey, type EligibleCustomerLike } from './eligibility.js';


export interface SelectionItem {
  customerId: string;
  surveyType: SurveyType;
}

export type SelectionRejectReason =
  | 'UNKNOWN_CUSTOMER'
  | 'INACTIVE_CUSTOMER'
  | 'WRONG_SURVEY_TYPE'
  | 'ALREADY_SELECTED'
  | 'NOT_SELECTED'
  | 'DUPLICATE_IN_REQUEST'
  | 'CONFLICTING';

export interface RejectedSelectionItem extends SelectionItem {
  op: 'add' | 'remove';
  reason: SelectionRejectReason;
  message: string;
}

export interface SelectionRequest {
  current: readonly SelectionItem[];
  add?: readonly SelectionItem[];
  remove?: readonly SelectionItem[];
}

export interface SelectionContext {
  /** The operator's own customers (any status). */
  customers: readonly EligibleCustomerLike[];
  cycleType: CycleType;
  participantSurveyTypes?: readonly SurveyType[];
}

export interface SelectionResult {
  /** The new selection: current minus removed, plus added, in that order. */
  selection: SelectionItem[];
  added: SelectionItem[];
  removed: SelectionItem[];
  rejected: RejectedSelectionItem[];
}

const keyOf = (item: SelectionItem): string => selectionKey(item.customerId, item.surveyType);

function firstOccurrences(items: readonly SelectionItem[], op: 'add' | 'remove', rejected: RejectedSelectionItem[]): SelectionItem[] {
  const seen = new Set<string>();
  const unique: SelectionItem[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      rejected.push({ ...item, op, reason: 'DUPLICATE_IN_REQUEST', message: 'Listed more than once in the request' });
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

/**
 * Removes are applied before adds. An item named in both lists is rejected on
 * both sides (CONFLICTING). A remove needs no eligibility check: a customer
 * deactivated after selection must still be removable.
 */
export function applySelection(request: SelectionRequest, context: SelectionContext): SelectionResult {
  const rejected: RejectedSelectionItem[] = [];
  const adds = firstOccurrences(request.add ?? [], 'add', rejected);
  const removes = firstOccurrences(request.remove ?? [], 'remove', rejected);

  const addKeys = new Set(adds.map(keyOf));
  const removeKeys = new Set(removes.map(keyOf));
  const conflicting = new Set([...addKeys].filter((key) => removeKeys.has(key)));
  for (const item of adds) {
    if (conflicting.has(keyOf(item))) {
      rejected.push({ ...item, op: 'add', reason: 'CONFLICTING', message: 'Listed in both add and remove' });
    }
  }
  for (const item of removes) {
    if (conflicting.has(keyOf(item))) {
      rejected.push({ ...item, op: 'remove', reason: 'CONFLICTING', message: 'Listed in both add and remove' });
    }
  }

  const selection = new Map<string, SelectionItem>();
  for (const item of request.current) selection.set(keyOf(item), item);

  const removed: SelectionItem[] = [];
  for (const item of removes) {
    const key = keyOf(item);
    if (conflicting.has(key)) continue;
    if (!selection.has(key)) {
      rejected.push({ ...item, op: 'remove', reason: 'NOT_SELECTED', message: 'Not in the current selection' });
      continue;
    }
    selection.delete(key);
    removed.push(item);
  }

  const customersById = new Map(context.customers.map((customer) => [customer.id, customer]));
  const added: SelectionItem[] = [];
  for (const item of adds) {
    const key = keyOf(item);
    if (conflicting.has(key)) continue;
    const customer = customersById.get(item.customerId);
    if (customer === undefined) {
      rejected.push({ ...item, op: 'add', reason: 'UNKNOWN_CUSTOMER', message: 'No such customer for this operator' });
      continue;
    }
    if (customer.status !== 'ACTIVE') {
      rejected.push({ ...item, op: 'add', reason: 'INACTIVE_CUSTOMER', message: 'Customer is inactive' });
      continue;
    }
    const allowed = eligibleSurveyTypes(customer.surveyType, context.cycleType, context.participantSurveyTypes);
    if (!allowed.includes(item.surveyType)) {
      rejected.push({
        ...item,
        op: 'add',
        reason: 'WRONG_SURVEY_TYPE',
        message: `Customer is not eligible for the ${item.surveyType} survey in this cycle`,
      });
      continue;
    }
    if (selection.has(key)) {
      rejected.push({ ...item, op: 'add', reason: 'ALREADY_SELECTED', message: 'Already selected' });
      continue;
    }
    selection.set(key, item);
    added.push(item);
  }

  return { selection: [...selection.values()], added, removed, rejected };
}
