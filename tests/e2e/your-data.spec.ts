/**
 * Your data page: what's stored is counted, and "Erase everything" leaves
 * nothing behind — no records in any store, no theme mirror, no theme
 * choice still applied.
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(
  new URL('../fixtures/hdfc_style.csv', import.meta.url),
);

test('your data: counts what is stored, and erase everything empties it', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.getByTitle('Dark').click();
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();
  await expect(page.locator('.card-grid')).toBeVisible();

  await page.getByRole('link', { name: 'Your data', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your data', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Your data · Kardabra');
  await expect(
    page.getByText(/^1 card, 1 statement and \d+ transactions\.$/),
  ).toBeVisible();
  await expect(page.getByText(/^None saved\./)).toBeVisible();

  // Two steps, and the first lands focus on Cancel; Cancel changes nothing.
  await page.getByRole('button', { name: 'Erase everything' }).click();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.getByRole('button', { name: 'Erase everything' }),
  ).toBeFocused();

  await page.getByRole('button', { name: 'Erase everything' }).click();
  await page.getByRole('button', { name: 'Erase permanently' }).click();

  await expect(page.getByText('No cards yet')).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // The app re-mirrors its default on load; absent and 'system' mean the same.
  expect([null, 'system']).toContain(
    await page.evaluate(() => localStorage.getItem('kardabra-theme')),
  );
  const leftovers = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('kardabra');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const names = [...db.objectStoreNames];
          const tx = db.transaction(names);
          let total = 0;
          for (const name of names) {
            tx.objectStore(name).count().onsuccess = (e) => {
              total += (e.target as IDBRequest<number>).result;
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve(total);
          };
        };
      }),
  );
  expect(leftovers).toBe(0);
});

test('your data: erasing in one tab starts every other tab over', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();
  await page.locator('.card-tile').first().click();
  await expect(page.getByRole('heading', { name: 'Statements' })).toBeVisible();

  const other = await context.newPage();
  await other.goto('/#/data');
  await other.getByRole('button', { name: 'Erase everything' }).click();
  await other.getByRole('button', { name: 'Erase permanently' }).click();
  await expect(other.getByText('No cards yet')).toBeVisible();

  // The first tab, which was showing the card, now shows nothing.
  await expect(page.getByText('No cards yet')).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
});
