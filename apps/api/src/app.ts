import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import type { Env } from './config/env.js';
import type { Database } from './db/connect.js';
import { createAuthenticator } from './kernel/auth.js';
import { errorHandler, notFoundHandler } from './kernel/errors.js';
import { healthModule } from './kernel/health.js';
import type { Logger } from './kernel/logger.js';
import { REQUEST_ID_HEADER, getRequestId, requestIdMiddleware } from './kernel/requestId.js';
import { mountModules } from './kernel/router.js';
import { MODULES } from './modules/index.js';

export interface AppDeps {
  readonly env: Env;
  readonly log: Logger;
  readonly db: Database;
}

/**
 * Assembled separately from main so a test can build the whole application,
 * including the real route table and the real policy checks, without owning a
 * process or a signal handler.
 */
export function createApp(deps: AppDeps): Express {
  const { env, log, db } = deps;
  const app = express();

  // behind an ALB or ingress the client address arrives in a header; without
  // this, rate limiting and audit logs would all record the proxy
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: [...env.CORS_ORIGINS],
      credentials: true,
      allowedHeaders: ['authorization', 'content-type', REQUEST_ID_HEADER, 'x-csq-organisation'],
      exposedHeaders: [REQUEST_ID_HEADER],
    }),
  );
  // a body limit is a denial of service control, not a formatting preference
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req) => getRequestId(req as never),
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );

  const auth = createAuthenticator(
    { issuer: env.KEYCLOAK_ISSUER, jwksUri: env.KEYCLOAK_JWKS_URI, audience: env.KEYCLOAK_AUDIENCE },
    log,
  );

  app.use(
    mountModules([healthModule(db, new Date()), ...MODULES], {
      authenticate: auth.authenticate,
      enterSelfScope: auth.enterSelfScope,
      enterOrgScope: auth.enterOrgScope,
      log,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler(log));

  return app;
}
