import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against the shared package's TypeScript source, like the API's tests.
    alias: { '@yatri/types': path.resolve(__dirname, '../types/src/index.ts') },
  },
  test: { environment: 'node' },
});
