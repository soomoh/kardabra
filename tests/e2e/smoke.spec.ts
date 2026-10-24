/**
 * Smoke path through the real app in Chromium: empty start, import a
 * synthetic fixture, see the card on the dashboard — and prove the page makes
 * no request beyond localhost while doing it (the app's privacy promise).
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(
  new URL('../fixtures/hdfc_style.csv', import.meta.url),
);

test('import a statement and see it on the dashboard, with no network', async ({
  page,
}) => {
  const offsite: string[] = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost') return route.continue();
    offsite.push(url.href);
    return route.abort();
  });

  await page.goto('/');
  await expect(page.getByText('No cards yet')).toBeVisible();

  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await expect(page.getByText('Name this card')).toBeVisible();

  await page.getByRole('spinbutton').fill('15');
  await page
    .getByRole('button', { name: 'Import', exact: true })
    .last()
    .click();

  await expect(page.locator('.card-grid')).toBeVisible();
  await expect(page.getByText('₹12,345.67').first()).toBeVisible();
  expect(offsite).toEqual([]);
});
