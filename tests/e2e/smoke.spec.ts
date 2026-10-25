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
  // The statement prints its due date, so nothing is asked: Import is ready.
  await expect(page.getByText('due 02-11-2025')).toBeVisible();
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Import', exact: true })
    .last()
    .click();

  await expect(page.locator('.card-grid')).toBeVisible();
  await expect(page.getByText('₹12,345.67').first()).toBeVisible();
  expect(offsite).toEqual([]);
});

test('unlock a password-protected PDF with cardholder details, with no network', async ({
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
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page
    .locator('#statement-file-input')
    .setInputFiles(
      fileURLToPath(
        new URL('../fixtures/pdf_statement_locked.pdf', import.meta.url),
      ),
    );

  await expect(
    page.getByRole('heading', { name: 'Password-protected statements' }),
  ).toBeVisible();
  // Fabricated cardholder of the synthetic fixture (password JANE2010).
  await page.getByLabel('Name as on the card').fill('Jane Doe');
  await page.getByLabel(/Date of birth/).fill('20/10/1990');
  await page.getByRole('button', { name: 'Unlock' }).click();

  await expect(page.getByText('Name this card')).toBeVisible();
  await expect(page.getByText('3 txns')).toBeVisible();
  await expect(page.getByText('due 09-11-2025')).toBeVisible();
  // A name left blank takes the suggestion shown as its placeholder.
  await expect(page.getByPlaceholder('Card ····4242')).toHaveValue('');
  await page
    .getByRole('button', { name: 'Import', exact: true })
    .last()
    .click();

  await expect(page.locator('.card-grid')).toBeVisible();
  await expect(page.getByText('₹12,345.67').first()).toBeVisible();
  await expect(page.getByText('Card ····4242')).toBeVisible();
  expect(offsite).toEqual([]);
});
