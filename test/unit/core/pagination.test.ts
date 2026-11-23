import { expect, it } from 'vitest';

import { parsePageSort } from '../../../src/core/pagination.js';

it('appends a unique tie-breaker after the requested pagination sort fields', () => {
  expect(Object.entries(parsePageSort('-status,name', ['status', 'name'], 'name'))).toEqual([
    ['status', -1],
    ['name', 1],
    ['_id', 1],
  ]);
  expect(Object.entries(parsePageSort(undefined, ['name'], 'name'))).toEqual([
    ['name', 1],
    ['_id', 1],
  ]);
});
