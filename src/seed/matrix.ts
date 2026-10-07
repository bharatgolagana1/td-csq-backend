/**
 * Default Role → Task matrix (ARCHITECTURE §4) as patterns over task codes:
 * `*` everything, `prefix.*`, `*.suffix`, or an exact code. Patterns are
 * resolved against the tasks that exist, so a module added later gets its
 * defaults the next time `npm run seed` runs. The seed only inserts missing
 * grants; what administrators changed in the matrix UI is never overwritten.
 *
 * AIRPORT_ADMIN receives `users.view` alongside `users.manage` (the doc lists
 * only users.manage; managing users without listing them is not usable).
 */
export const DEFAULT_MATRIX: Readonly<Record<string, readonly string[]>> = {
  SUPER_ADMIN: ['*'],
  ACFI_ANALYST: ['*.view', 'reports.*', 'monitoring.view'],
  ACO_ADMIN: [
    'customers.*',
    'sampling.view',
    'sampling.manage',
    'sampling.lock',
    'assessments.self',
    'assessments.view',
    'reports.operator',
    'users.view',
    'users.manage',
    'settings.view',
  ],
  ACO_USER: ['customers.view', 'sampling.view', 'assessments.self', 'reports.operator'],
  AIRPORT_ADMIN: ['reports.airport', 'users.view', 'users.manage'],
  AIRPORT_VIEWER: ['reports.airport'],
};

export function matchesPattern(code: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return code.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith('*.')) return code.endsWith(pattern.slice(1));
  return code === pattern;
}

export function resolvePatterns(patterns: readonly string[], codes: readonly string[]): string[] {
  return codes.filter((code) => patterns.some((pattern) => matchesPattern(code, pattern)));
}
