// The ONLY reader of process.env (ARCHITECTURE §2). Everything else receives
// the parsed `Env` object. `loadEnv()` exits listing every problem it finds.
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const url = z.url();
const boolish = z.stringbool();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(0).max(65535).default(4000),
    MONGO_URI: nonEmpty.regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// or mongodb+srv:// URI'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    KEYCLOAK_ISSUER: url,
    KEYCLOAK_JWKS_URI: url,
    KEYCLOAK_AUDIENCE: nonEmpty,
    KEYCLOAK_ADMIN_URL: url.optional(),
    KEYCLOAK_ADMIN_CLIENT_ID: nonEmpty.optional(),
    KEYCLOAK_ADMIN_CLIENT_SECRET: nonEmpty.optional(),

    CORS_ORIGINS: nonEmpty
      .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
      .pipe(z.array(z.url()).min(1, 'must list at least one origin')),
    PUBLIC_WEB_URL: url,

    LINK_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),

    SMTP_URL: nonEmpty.regex(/^smtps?:\/\//, 'must be an smtp:// or smtps:// URL').optional(),
    MAIL_FROM: nonEmpty,

    DEMO_REVEAL_OTP: boolish.default(false),
    SCHEDULER_ENABLED: boolish.default(true),
  })
  .superRefine((env, ctx) => {
    const admin = [env.KEYCLOAK_ADMIN_URL, env.KEYCLOAK_ADMIN_CLIENT_ID, env.KEYCLOAK_ADMIN_CLIENT_SECRET];
    const set = admin.filter((value) => value !== undefined).length;
    if (set !== 0 && set !== admin.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['KEYCLOAK_ADMIN_URL'],
        message: 'KEYCLOAK_ADMIN_URL, KEYCLOAK_ADMIN_CLIENT_ID and KEYCLOAK_ADMIN_CLIENT_SECRET must be set together',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export type EnvResult = { ok: true; env: Env } | { ok: false; problems: string[] };

/** Parses an environment map without side effects. Empty strings count as unset. */
export function parseEnv(source: Record<string, string | undefined>): EnvResult {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (result.success) return { ok: true, env: result.data };
  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(env)';
    const message = issue.code === 'invalid_type' && issue.message.includes('undefined') ? 'is required' : issue.message;
    return `${name}: ${message}`;
  });
  return { ok: false, problems };
}

/** Parses `process.env`; on failure prints every problem and exits with code 1. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = parseEnv(source);
  if (result.ok) return result.env;
  console.error('Invalid environment:');
  for (const problem of result.problems) console.error(`  - ${problem}`);
  console.error('See .env.example for every variable.');
  process.exit(1);
}
