import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The ANTLR-backed language layer runs synchronously with no worker, so the
    // analyzer/splitter/completion tests need no special setup.
    globals: false,
  },
});
