import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    // Tests share one Postgres/Redis instance and truncate between tests;
    // running files in parallel would race on that shared state.
    fileParallelism: false,
  },
});
