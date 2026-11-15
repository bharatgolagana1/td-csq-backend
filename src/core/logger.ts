import pino, { type Logger } from 'pino';

/**
 * Credentials never reach the log: the Keycloak bearer token, cookies, the
 * participant / registration link session (`x-csq-link-token`, written out
 * because core/auth/link.ts imports errors.ts, which imports this module),
 * and the raw link token a route receives as `:token` (it only ever travels
 * in the e-mail).
 */
export const LOG_REDACT = {
  paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csq-link-token"]', 'req.params.token'],
  censor: '[redacted]',
};

const TOKEN_IN_URL = /(\/public\/(?:assess|onboarding)\/)[^/?#]+/;

/** `/api/v1/public/assess/<token>/form` → `/api/v1/public/assess/[redacted]/form`. */
export function redactUrl(url: string): string {
  return url.replace(TOKEN_IN_URL, '$1[redacted]');
}

/**
 * The application logger. It starts as a plain JSON logger so that code which
 * runs before `initLogger` (module evaluation) can still log; `server.ts`
 * replaces it once the environment is known. ESM live bindings mean every
 * importer sees the replacement.
 */
export let logger: Logger = pino({ level: 'info', redact: LOG_REDACT });

export interface LoggerOptions {
  level: string;
  /** Human-readable output through pino-pretty (development only). */
  pretty: boolean;
}

export function initLogger(options: LoggerOptions): Logger {
  logger = pino({
    level: options.level,
    redact: LOG_REDACT,
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
  return logger;
}
