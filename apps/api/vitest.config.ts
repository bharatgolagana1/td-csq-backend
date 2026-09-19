import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // the tenancy suite talks to a real MongoDB; sharing one connection across
    // files in one process is cheaper and avoids replica-set election storms
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
