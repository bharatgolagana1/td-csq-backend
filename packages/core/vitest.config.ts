import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@csq/contracts': resolve(__dirname, '../contracts/src/index.ts') },
  },
  test: { include: ['test/**/*.test.ts'] },
});
