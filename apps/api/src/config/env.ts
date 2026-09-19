import { z } from 'zod';

/**
 * The only file in the API that reads process.env.
 *
 * Everything downstream receives configuration as an argument, which is what
 * makes the kernel testable and keeps a module from quietly reaching for a
 * variable nobody validated. A missing or malformed value stops the process:
 * a default that "looks like it works" is how a staging build ends up pointed
 * at a production database.
 */

const csvOrigins = z
  .string()
  .min(1)
  .transform((raw) => raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
  .pipe(
    z
      .array(z.string().url('each CORS origin must be an absolute URL, e.g. https://app.csq.in'))
      .min(1, 'at least one origin is required'),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65_535),
  MONGO_URI: z
    .string()
    .min(1)
    .refine(
      (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'),
      'must be a mongodb:// or mongodb+srv:// connection string',
    ),
  KEYCLOAK_ISSUER: z.string().url(),
  KEYCLOAK_JWKS_URI: z.string().url(),
  KEYCLOAK_AUDIENCE: z.string().min(1),
  CORS_ORIGINS: csvOrigins,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

export class EnvError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid environment:\n  ${problems.join('\n  ')}`);
    this.name = 'EnvError';
  }
}

function describe(issue: z.ZodIssue): string {
  const name = issue.path.join('.') || '(root)';
  return issue.code === 'invalid_type' && issue.received === 'undefined'
    ? `${name} is required but not set`
    : `${name}: ${issue.message}`;
}

/** Validates a candidate environment. Exported separately so tests never need a process. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(result.error.issues.map(describe).sort());
  }
  return Object.freeze(result.data);
}

let cached: Env | undefined;

/** Parses process.env once per process and hands back the same frozen object. */
export function loadEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
