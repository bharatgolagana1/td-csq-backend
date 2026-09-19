import { createHash } from 'node:crypto';
import { fail } from '../../kernel/errors.js';
import { SnapshotContent } from './refdata.contracts.js';

/**
 * Content addressing for the question bank.
 *
 * A snapshot's identifier is the hash of the instrument it contains, so the
 * same instrument cannot exist twice under two identifiers and a changed
 * instrument cannot keep an old one. An assessment records the snapshot id it
 * was answered against; if that id still resolves, the questions are provably
 * the ones the assessor saw.
 */

/** Stable JSON: keys sorted at every level, array order preserved, no whitespace. */
export function canonicalise(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw fail('INTERNAL', 'Content to be hashed contains a non finite number');
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        // an absent key and a key set to undefined must hash the same, because
        // Mongo stores neither and the read back value would differ otherwise
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
    }
    default:
      throw fail('INTERNAL', `Content to be hashed contains a ${typeof value}`);
  }
}

export function hashContent(content: SnapshotContent): string {
  return createHash('sha256').update(canonicalise(content), 'utf8').digest('hex');
}

/**
 * Parses stored content and checks it still hashes to the identifier it is
 * filed under. A mismatch means the row was changed by something that did not
 * go through this code, which is the exact event content addressing exists to
 * detect, so it is an error rather than a warning.
 */
export function readVerifiedContent(id: string, stored: unknown): SnapshotContent {
  const parsed = SnapshotContent.safeParse(stored);
  if (!parsed.success) {
    throw fail('INTERNAL', `Question bank snapshot ${id} is not a valid instrument`);
  }
  const actual = hashContent(parsed.data);
  if (actual !== id) {
    throw fail('INTERNAL', `Question bank snapshot ${id} does not match its content hash`);
  }
  return parsed.data;
}
