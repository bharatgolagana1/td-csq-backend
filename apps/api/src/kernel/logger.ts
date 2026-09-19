import pino, { type Logger } from 'pino';

export type { Logger };

/**
 * One logger for the process. Credentials and tokens are redacted at the
 * serialiser rather than at each call site, because the one call site that
 * forgets is the one that ends up in a log aggregator with a bearer token in it.
 */
export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.secret',
      ],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino/file', options: { destination: 1 } } } : {}),
  });
}
