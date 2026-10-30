import { defineConfig, devices } from '@playwright/test';

// Browser smoke tests. Playwright starts the dev server itself so server and
// browser share one process tree; see Launchpad's browser-testing recipe.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts', // unit tests are *.test.ts and run under Vitest
  use: { baseURL: 'http://localhost:4173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev -- --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
    },
    {
      // The production build, for what only exists there (the CSP). Never
      // reused: a stale build would test old code.
      command: 'npm run build && npx vite preview --port 4174 --strictPort',
      url: 'http://localhost:4174',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
