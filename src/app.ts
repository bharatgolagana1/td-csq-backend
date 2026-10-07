import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import type { Env } from './config/env.js';
import type { TokenVerifier } from './core/auth/keycloak.js';
import { createLinkSessions } from './core/auth/link.js';
import { errorHandler, notFoundHandler } from './core/errors.js';
import { logger } from './core/logger.js';
import { requestId, requestIdOf } from './core/request-id.js';
import { buildApiRouter } from './modules/index.js';
import { configureNotifications } from './modules/notifications/notifications.service.js';
import { createTransport } from './modules/notifications/notifications.transport.js';
import { DEFAULT_SETTINGS } from './modules/settings/settings.service.js';

export interface AppOptions {
  env: Env;
  /** Injected so tests can accept `test:<json>` tokens without Keycloak. */
  verifyToken: TokenVerifier;
}

/** Express app factory: helmet, cors, json, request id, pino-http, /api/v1 routers, error handler. */
export function createApp({ env, verifyToken }: AppOptions): Express {
  configureNotifications({
    transport: createTransport(env),
    from: env.MAIL_FROM,
    webUrl: env.PUBLIC_WEB_URL,
    brandName: DEFAULT_SETTINGS.branding.orgName,
  });
  const links = createLinkSessions(env.LINK_SESSION_SECRET);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.set('query parser', 'simple');

  app.use(requestId());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => requestIdOf(req as express.Request),
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
      customLogLevel: (_req, res, error) => (error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true, exposedHeaders: ['x-request-id'] }));
  app.use(express.json({ limit: '2mb' }));

  app.use('/api/v1', buildApiRouter({ verifyToken, links }));

  app.use(notFoundHandler());
  app.use(errorHandler());
  return app;
}
