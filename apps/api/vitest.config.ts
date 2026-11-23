import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    setupFiles: ['reflect-metadata'],
    // The PostgreSQL suites share one database and each switches the tenant's
    // current semester, so test files run one after another.
    fileParallelism: false,
  },
});
