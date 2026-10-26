import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Screenshots for looking at a UI change — local only, not part of CI.
// Run: npx playwright test -c playwright.visual.config.ts
// Output: test-results-visual/<test>/<screen>.png (a sibling of test-results/,
// which the e2e suite wipes on every run)
export default defineConfig({
  ...base,
  testDir: 'tests/visual',
  outputDir: 'test-results-visual',
});
