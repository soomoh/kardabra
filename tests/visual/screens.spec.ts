/**
 * Every main screen in both themes, at desktop and phone width, from the
 * synthetic fixtures plus five generated months of history (so the trends
 * chart has shape). For reading by eye after a UI change; asserts nothing
 * beyond the screens loading.
 */
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const VIEWPORTS = [
  { tag: 'desktop', viewport: { width: 1200, height: 900 } },
  { tag: 'phone', viewport: { width: 393, height: 852 } },
] as const;

async function shot(page: Page, name: string) {
  await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    fullPage: true,
  });
}

/** Five earlier months per card, paid, so the chart has a history. */
async function seedHistory(page: Page) {
  await page.evaluate(async () => {
    // Resolved by the dev server in the page, not by TypeScript.
    const url = '/src/db/db.ts';
    const db = (await import(
      /* @vite-ignore */ url
    )) as typeof import('../../src/db/db');
    const conn = await db.openKardabraDb();
    const cards = await db.getAllCards(conn);
    const cycles = await db.getAllCycles(conn);
    const latest = cycles
      .map((c) => c.period)
      .sort()
      .at(-1)!;
    let [year, month] = latest.split('-').map(Number);
    for (let k = 1; k <= 5; k++) {
      month -= 1;
      if (month === 0) [year, month] = [year - 1, 12];
      const period = `${year}-${String(month).padStart(2, '0')}`;
      for (const [i, card] of cards.entries()) {
        await db.upsertCycle(conn, {
          cardId: card.id,
          period,
          dueDateISO: null,
          source: 'statement',
          spend: 4000 + ((k * 3 + i * 7) % 9) * 2100 + i * 3000,
          paidAt: '2025-01-01',
        });
      }
    }
    conn.close();
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const { tag, viewport } of VIEWPORTS) {
    test.describe(`${colorScheme} ${tag}`, () => {
      test.use({ colorScheme, viewport, deviceScaleFactor: 1 });

      test('screens', async ({ page }) => {
        await page.goto('/');
        await shot(page, 'empty');

        await page.getByRole('button', { name: 'Import', exact: true }).click();
        await page
          .locator('#statement-file-input')
          .setInputFiles(fixture('pdf_statement_locked.pdf'));
        await page.getByLabel('Name as on your card').fill('Jane Doe');
        await page.getByLabel(/Date of birth/).fill('01/01/1990');
        await page.getByRole('button', { name: 'Unlock' }).click();
        await expect(page.getByRole('alert')).toBeVisible();
        await shot(page, 'unlock-retry');
        await page.getByRole('button', { name: 'Skip this file' }).click();
        await page.getByRole('button', { name: 'Cancel' }).click();

        await page
          .locator('#statement-file-input')
          .setInputFiles(
            [
              'hdfc_style.csv',
              'axis_style.xlsx',
              'legacy.xls',
              'savings_reject.csv',
            ].map(fixture),
          );
        await expect(
          page.getByRole('heading', { name: 'Review and import' }),
        ).toBeVisible();
        await shot(page, 'review');
        await page.getByLabel('Due day of the month').fill('15');
        await page
          .getByRole('button', { name: /^Import \d+ statements?$/ })
          .click();
        await expect(page.locator('.card-grid')).toBeVisible();

        await seedHistory(page);
        await page.reload();
        await expect(page.locator('.trends-section')).toBeVisible();
        await shot(page, 'dashboard');
        await page.getByRole('button', { name: 'View as table' }).click();
        await shot(page, 'trends-table');

        await page.locator('.card-tile').first().click();
        await expect(
          page.getByRole('heading', { name: 'Transactions' }),
        ).toBeVisible();
        await shot(page, 'card');
      });
    });
  }
}
