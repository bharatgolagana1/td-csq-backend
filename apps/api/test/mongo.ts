import mongoose from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { createDatabase, type Database } from '../src/db/connect.js';
import { createLogger, type Logger } from '../src/kernel/logger.js';
import type { Principal } from '../src/kernel/requestContext.js';

export const silentLog: Logger = createLogger('silent', false);

let db: Database | undefined;

export async function openDatabase(): Promise<Database> {
  if (!db) {
    db = createDatabase({ uri: loadEnv().MONGO_URI, log: silentLog, maxPoolSize: 5, minPoolSize: 1 });
    await db.connect();
  }
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.disconnect();
    db = undefined;
  }
}

/** Drops the documents of the named collections without dropping their indexes. */
export async function clear(...models: Array<{ deleteMany: (f: object) => { exec: () => Promise<unknown> } }>): Promise<void> {
  for (const model of models) {
    await mongoose.connection.collection(collectionOf(model)).deleteMany({});
  }
}

function collectionOf(model: unknown): string {
  const named = model as { collection?: { name?: string } };
  const name = named.collection?.name;
  if (!name) throw new Error('not a mongoose model');
  return name;
}

export function principal(userId: string, ...orgIds: string[]): Principal {
  return {
    userId,
    subject: `sub-${userId}`,
    email: null,
    displayName: userId,
    memberships: orgIds.map((orgId) => ({
      orgId,
      roles: ['ADMIN'],
      capabilities: ['settings:read', 'settings:write', 'settings.lists:write'],
      active: true,
    })),
  };
}
