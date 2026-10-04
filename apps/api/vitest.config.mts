import path from 'node:path';
import { defineConfig } from 'vitest/config';

import { TEST_WORKERS } from './src/test/workers';

export default defineConfig({
  resolve: {
    // Tests run against the shared package's TypeScript source (production runs its compiled dist).
    alias: { '@yatri/types': path.resolve(__dirname, '../../packages/types/src/index.ts') },
  },
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    globalSetup: ['./src/test/global-setup.ts'],
    // worker-env first: it points each worker at its own database before the app reads its configuration.
    setupFiles: ['./src/test/worker-env.ts', './src/test/setup.ts'],
    // These are integration tests against a real database and Redis; each test also clears the database first. On a slow or
    // busy machine (a CI runner, a laptop low on memory) 15 s timed out with nothing wrong. A real failure still fails.
    testTimeout: 60000,
    hookTimeout: 60000,
    // In GitHub Actions, also report each failing test as an annotation on the run, so the failure is readable on the run page
    // without access to the full log.
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'],
    // Files run in parallel, each worker on its own database and Redis database (see src/test/workers.ts), so the
    // truncating and flushing between tests cannot race. `maxWorkers` is the number of copies made.
    fileParallelism: true,
    maxWorkers: TEST_WORKERS,
    minWorkers: 1,
  },
});
