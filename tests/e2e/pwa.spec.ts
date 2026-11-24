/**
 * The installable, offline app, checked on the production build (the
 * service worker and manifest exist only there): once loaded, the app opens
 * and reads statements, PDFs included, with no network at all.
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test.use({ baseURL: 'http://localhost:4174' });

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

test('the manifest is linked and its icons exist', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const response = await page.request.get(href!);
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    name: 'Kardabra',
    start_url: '/',
    display: 'standalone',
  });
  for (const icon of manifest.icons as { src: string }[]) {
    expect((await page.request.get(icon.src)).ok(), icon.src).toBe(true);
  }
});

test('after one visit, the app opens and imports offline', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Import', exact: true }),
  ).toBeVisible();

  // The PDF path loads pdf.js and its worker on demand: both from the cache.
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page
    .locator('#statement-file-input')
    .setInputFiles([
      fixture('hdfc_style.csv'),
      fixture('pdf_statement_locked.pdf'),
    ]);
  await page.getByLabel('Name as on your card').fill('Jane Doe');
  await page.getByLabel(/Date of birth/).fill('20/10/1990');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(
    page.getByRole('heading', { name: 'Review and import' }),
  ).toBeVisible();
  await expect(page.getByText('3 transactions')).toHaveCount(2);
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();
  await expect(page.locator('.card-grid')).toBeVisible();
});

test('offline: a deep link opens its page, and a file address opens the file', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);

  await page.goto('/#/data');
  await expect(
    page.getByRole('heading', { name: 'Your data', exact: true }),
  ).toBeVisible();
  // Not the app shell: the manifest itself, from the cache.
  await page.goto('/manifest.webmanifest');
  expect(await page.locator('body').innerText()).toContain('"short_name"');
});

test('a cache cleared under the worker fills again on the next visit', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.evaluate(async () => {
    for (const key of await caches.keys()) await caches.delete(key);
  });

  await page.reload();
  await page.waitForFunction(async () => {
    const keys = await caches.keys();
    if (keys.length === 0) return false;
    return (await caches.open(keys[0]).then((c) => c.match('/'))) !== undefined;
  });
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Import', exact: true }),
  ).toBeVisible();
});
