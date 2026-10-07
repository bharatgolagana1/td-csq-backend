import mongoose, { type ClientSession } from 'mongoose';

import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri: string): Promise<void> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000 });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function isDbConnected(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

/** Round-trips to the server; false when disconnected or the ping fails. */
export async function pingDb(): Promise<boolean> {
  if (!isDbConnected()) return false;
  try {
    await mongoose.connection.db?.admin().ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` inside a multi-document transaction (the database is a replica
 * set). Every query inside must pass `{ session }`; the transaction is retried
 * by the driver on transient errors, so `fn` must be safe to re-run.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}

/** Builds every registered model's indexes; used after a test database reset. */
export async function ensureIndexes(): Promise<void> {
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
}
