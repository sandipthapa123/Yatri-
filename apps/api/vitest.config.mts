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
    testTimeout: 15000,
    hookTimeout: 15000,
    // Files run in parallel, each worker on its own database and Redis database (see src/test/workers.ts), so the
    // truncating and flushing between tests cannot race. `maxWorkers` is the number of copies made.
    fileParallelism: true,
    maxWorkers: TEST_WORKERS,
    minWorkers: 1,
  },
});
