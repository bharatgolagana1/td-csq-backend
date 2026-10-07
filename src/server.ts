// Boot: env → logger → db → modules (tasks, settings) → app → scheduler → listen.
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createTokenVerifier } from './core/auth/keycloak.js';
import { connectDb, disconnectDb } from './core/db.js';
import { initLogger, logger } from './core/logger.js';
import { scheduler } from './core/scheduler.js';
import { APP_NAME, APP_VERSION } from './core/version.js';
import { registerJobs } from './jobs/index.js';
import { syncModuleTasks, validateModules } from './modules/index.js';
import { ensureSettings } from './modules/settings/settings.service.js';

const env = loadEnv();
initLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });

validateModules();
await connectDb(env.MONGO_URI);
await syncModuleTasks();
await ensureSettings();

const app = createApp({ env, verifyToken: createTokenVerifier(env) });

scheduler.configure({ enabled: env.SCHEDULER_ENABLED });
registerJobs();
scheduler.start();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, version: APP_VERSION }, `${APP_NAME} listening`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  await scheduler.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
