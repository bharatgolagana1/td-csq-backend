import mongoose, { type Connection } from 'mongoose';
import type { Logger } from '../kernel/logger.js';

/**
 * One connection for the process, with a pool big enough for the request
 * concurrency an instance actually handles and small enough that a dozen
 * instances cannot exhaust the server's connection limit between them.
 */
export interface DatabaseOptions {
  readonly uri: string;
  readonly log: Logger;
  readonly maxPoolSize?: number;
  readonly minPoolSize?: number;
}

export interface Database {
  readonly connection: Connection;
  connect(): Promise<void>;
  /** Cheap liveness probe for /readyz. */
  ping(): Promise<boolean>;
  disconnect(): Promise<void>;
}

export function createDatabase(options: DatabaseOptions): Database {
  const { uri, log } = options;

  // strictQuery keeps a typo in a filter from silently matching everything,
  // which on a tenant-scoped collection is the worst possible failure mode
  mongoose.set('strictQuery', true);

  const connection = mongoose.connection;

  connection.on('connected', () => log.info('mongo connected'));
  connection.on('disconnected', () => log.warn('mongo disconnected'));
  connection.on('reconnected', () => log.info('mongo reconnected'));
  connection.on('close', () => log.info('mongo connection closed'));
  connection.on('error', (error: unknown) => log.error({ err: error }, 'mongo error'));

  return {
    connection,

    async connect(): Promise<void> {
      await mongoose.connect(uri, {
        maxPoolSize: options.maxPoolSize ?? 20,
        minPoolSize: options.minPoolSize ?? 2,
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
        // a write that is not acknowledged by a majority can be rolled back by
        // an election, and a sampling lock that un-locks itself is unrecoverable
        writeConcern: { w: 'majority' },
        retryWrites: true,
      });
      // an index build is a deploy-time operation, not something a request pays for
      await mongoose.syncIndexes().catch((error: unknown) => {
        log.warn({ err: error }, 'index sync incomplete');
      });
    },

    async ping(): Promise<boolean> {
      const db = connection.db;
      if (!db || connection.readyState !== 1) return false;
      try {
        await db.admin().ping();
        return true;
      } catch (error) {
        log.warn({ err: error }, 'mongo ping failed');
        return false;
      }
    },

    async disconnect(): Promise<void> {
      await mongoose.disconnect();
    },
  };
}
