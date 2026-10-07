import { defineConfig } from 'vitest/config';

// Tests run against a real MongoDB (database csq_test) and share one connection
// per file, so files run one at a time and tests within a file run in order.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 20_000,
    hookTimeout: 60_000,
    reporters: 'default',
  },
});
