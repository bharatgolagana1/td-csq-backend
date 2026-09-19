import { createServer } from 'node:http';
import { EnvError, loadEnv } from './config/env.js';
import { createDatabase } from './db/connect.js';
import { createLogger } from './kernel/logger.js';
import { createApp } from './app.js';

/**
 * Boot order matters. Configuration is validated before anything opens a socket,
 * the database is connected before the listener accepts a request, and the route
 * table is built before either, so a missing route policy fails the deploy
 * rather than the first request that hits it.
 */
async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production');
  const db = createDatabase({ uri: env.MONGO_URI, log });

  await db.connect();

  const app = createApp({ env, log, db });
  const server = createServer(app);

  // a request that is still being written when the process is told to stop must
  // finish; a half written response is indistinguishable from data loss
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  await new Promise<void>((resolve) => server.listen(env.PORT, resolve));
  log.info({ port: env.PORT, env: env.NODE_ENV }, 'csq api listening');

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');

    // stop accepting, let in flight requests drain, then release the pool
    const forced = setTimeout(() => {
      log.error('shutdown timed out with requests still in flight');
      process.exit(1);
    }, 20_000);
    forced.unref();

    server.close((error) => {
      if (error) log.error({ err: error }, 'server close failed');
      db.disconnect()
        .catch((dbError: unknown) => log.error({ err: dbError }, 'mongo disconnect failed'))
        .finally(() => {
          clearTimeout(forced);
          process.exit(error ? 1 : 0);
        });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled rejection');
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`Fatal during boot: ${String(error)}\n`);
  process.exit(1);
});
