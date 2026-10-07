import pino, { type Logger } from 'pino';

/**
 * The application logger. It starts as a plain JSON logger so that code which
 * runs before `initLogger` (module evaluation) can still log; `server.ts`
 * replaces it once the environment is known. ESM live bindings mean every
 * importer sees the replacement.
 */
export let logger: Logger = pino({ level: 'info' });

export interface LoggerOptions {
  level: string;
  /** Human-readable output through pino-pretty (development only). */
  pretty: boolean;
}

export function initLogger(options: LoggerOptions): Logger {
  logger = pino({
    level: options.level,
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
