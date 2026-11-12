// Boot-time migration of `scores` / `airport_scores` to rows keyed by direction
// (ARCHITECTURE §5). Rows written before answer modes existed carry no
// `direction`, and the unique index they were written under lacks it, so an
// IMPORT and an EXPORT row of the same ref would collide. Idempotent: run on
// every boot (server.ts, the demo seed, the test reset) before anything scores.
import type { Collection } from 'mongoose';

import { logger } from '../../core/logger.js';

import { AirportScoreModel } from './airport-scores.model.js';
import { ScoreModel } from './scores.model.js';

/** The unique keys before `direction` joined them, field by field in index order. */
const LEGACY_SCORE_KEY = ['cycleId', 'acoId', 'surveyType', 'level', 'refId'] as const;
const LEGACY_AIRPORT_SCORE_KEY = ['cycleId', 'airportId', 'surveyType', 'level', 'refId'] as const;

export interface DirectionMigrationResult {
  collection: string;
  /** Rows without a direction, now SINGLE. */
  backfilled: number;
  /** Names of the legacy unique indexes dropped (whatever they were called). */
  droppedIndexes: string[];
}

const NAMESPACE_NOT_FOUND = 26;

function hasKey(key: Record<string, unknown>, fields: readonly string[]): boolean {
  const entries = Object.entries(key);
  return entries.length === fields.length && entries.every(([field, order], i) => field === fields[i] && order === 1);
}

async function legacyIndexNames(collection: Collection, fields: readonly string[]): Promise<string[]> {
  try {
    const indexes = await collection.indexes();
    return indexes.filter((index) => hasKey(index.key, fields)).flatMap((index) => (index.name ? [index.name] : []));
  } catch (error) {
    if ((error as { code?: number }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

/** Backfill, then drop the legacy unique index, then ensure the schema's indexes (the direction-keyed unique one among them). */
async function migrate(collection: Collection, legacyKey: readonly string[], ensureIndexes: () => Promise<void>): Promise<DirectionMigrationResult> {
  const { modifiedCount } = await collection.updateMany({ direction: null }, { $set: { direction: 'SINGLE' } });
  const droppedIndexes = await legacyIndexNames(collection, legacyKey);
  for (const name of droppedIndexes) await collection.dropIndex(name);
  await ensureIndexes();
  return { collection: collection.collectionName, backfilled: modifiedCount, droppedIndexes };
}

/**
 * Contract: every score row has a direction (missing → SINGLE), the legacy
 * unique indexes are gone and the direction-keyed ones exist. Waits for the
 * models' own automatic index builds first so the two never race.
 */
export async function migrateScoreDirections(): Promise<DirectionMigrationResult[]> {
  await Promise.all([ScoreModel.init(), AirportScoreModel.init()]);
  const results = [
    await migrate(ScoreModel.collection, LEGACY_SCORE_KEY, () => ScoreModel.createIndexes()),
    await migrate(AirportScoreModel.collection, LEGACY_AIRPORT_SCORE_KEY, () => AirportScoreModel.createIndexes()),
  ];
  for (const result of results) {
    const changed = result.backfilled > 0 || result.droppedIndexes.length > 0;
    if (changed) logger.info(result, 'Score directions migrated');
    else logger.debug(result, 'Score directions already migrated');
  }
  return results;
}
