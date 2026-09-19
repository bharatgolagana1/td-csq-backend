import { z } from 'zod';

/**
 * Every document this system creates carries a 26-character ULID string `_id`.
 * Crockford base32, lexicographically sortable by creation time, and safe to
 * put in a URL. `I`, `L`, `O` and `U` are excluded from the alphabet.
 */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const Ulid = z.string().regex(ULID_RE, 'must be a 26-character ULID');
export type Ulid = z.infer<typeof Ulid>;

/** Branded id types. These are compile-time only; at runtime they are strings. */
export type Id<Brand extends string> = string & { readonly __brand: Brand };

export const idSchema = <B extends string>(_brand: B) =>
  Ulid as unknown as z.ZodType<Id<B>>;

export type OrgId = Id<'Org'>;
export type UserId = Id<'User'>;
export type CycleId = Id<'Cycle'>;
export type AssignmentId = Id<'Assignment'>;
export type AssessmentId = Id<'Assessment'>;
export type AirportId = Id<'Airport'>;
export type BatchId = Id<'Batch'>;
