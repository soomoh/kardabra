import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vite and Vitest share one config. Tests run in Node: the parser is pure, and
// the browser globals it does need (File, TextDecoder) exist in Node, with
// IndexedDB supplied by fake-indexeddb in the db/import tests that import it.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
