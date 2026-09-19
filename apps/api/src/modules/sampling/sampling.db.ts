import mongoose, { type ClientSession } from 'mongoose';
import { fail } from '../../kernel/errors.js';

/**
 * The two writes in this module that must be all or nothing are the import
 * commit and the batch lock. Both touch several collections, so both run in a
 * real multi document transaction against a replica set.
 *
 * There is deliberately no non transactional fallback. A lock that half
 * happened, with a frozen sample but no integrity observations and no audit
 * entry, is worse than a lock that failed: the failure can be retried, and the
 * half state is discovered a month later by whoever disputes the rating.
 */
export async function inTransaction<T extends object>(
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    // withTransaction retries transient errors and write conflicts itself, so
    // the body must stay idempotent: it may run more than once
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    if (result === undefined) throw fail('INTERNAL', 'The transaction produced no result');
    return result;
  } finally {
    await session.endSession();
  }
}

const DUPLICATE_KEY = 11000;

export function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY
  );
}
