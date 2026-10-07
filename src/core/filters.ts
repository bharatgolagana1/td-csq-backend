import type { FilterQuery } from 'mongoose';

/**
 * Combines filters with `$and` so a user-supplied key can never overwrite a
 * scope key (`{ ...scopeFilter, _id }` would silently drop the scope's `_id`).
 * Empty filters are ignored.
 */
export function and<T>(...parts: FilterQuery<T>[]): FilterQuery<T> {
  const present = parts.filter((part) => Object.keys(part).length > 0);
  if (present.length === 0) return {};
  const [single] = present;
  if (present.length === 1 && single) return single;
  return { $and: present };
}
