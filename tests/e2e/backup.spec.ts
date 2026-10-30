/**
 * Backup and restore in a real browser, on the production build (so under
 * the CSP): download a backup, then restore it on "another device" (a
 * fresh browser context with its own storage) using the passphrase.
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

test.use({ baseURL: 'http://localhost:4174' });

const fixture = fileURLToPath(
  new URL('../fixtures/hdfc_style.csv', import.meta.url),
);

test('backup: download on one device, restore on another', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();
  await expect(page.locator('.card-grid')).toBeVisible();

  await page.getByRole('link', { name: 'Your data', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    /^kardabra-backup-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const backupPath = await download.path();
  // The file is encrypted: no merchant, no card name readable in it.
  const text = readFileSync(backupPath, 'utf8');
  expect(JSON.parse(text).kardabra).toBe('backup');
  expect(text).not.toMatch(/HDFC|SWIGGY|AMAZON/i);

  // Shown once, with the file name.
  await expect(page.locator('.backup-news')).toBeFocused();
  await expect(page.locator('.backup-news')).toContainText(
    /^Your backup file is kardabra-backup-\d{4}-\d{2}-\d{2}\.json\. To restore it/,
  );
  const passphrase = (await page.locator('.passphrase').textContent())!.trim();
  expect(passphrase.split(' ')).toHaveLength(5);

  // A second backup reuses it and doesn't show it again unasked.
  await page.getByRole('button', { name: 'Download backup' }).click();
  await expect(
    page.getByText('It opens with your backup passphrase.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Show passphrase' }).click();
  await expect(page.locator('.passphrase')).toHaveText(passphrase);

  // Another device: its own storage, nothing on it.
  const phone = await browser.newContext({
    baseURL: 'http://localhost:4174',
  });
  const other = await phone.newPage();
  await other.goto('/#/data');
  await expect(other.getByText('Nothing to back up yet.')).toBeVisible();
  await other.locator('#backup-file-input').setInputFiles(backupPath);

  // Wrong passphrase first: refused, nothing restored.
  const field = other.getByRole('textbox', { name: 'Backup passphrase' });
  await expect(field).toBeFocused();
  await field.fill('acid acorn acre acts afar');
  await other.getByRole('button', { name: 'Open backup' }).click();
  await expect(other.getByRole('alert')).toHaveText(/doesn’t open this backup/);

  // Typed as a phone would: capitalised first letter.
  await field.fill(passphrase[0].toUpperCase() + passphrase.slice(1));
  await other.getByRole('button', { name: 'Open backup' }).click();
  await expect(
    other.getByText(/^This backup from .* has 1 card and 1 statement\./),
  ).toBeVisible();
  await expect(other.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await other.getByRole('button', { name: 'Replace with backup' }).click();
  await expect(
    other.getByText(/^Restored 1 card and 1 statement from the backup of/),
  ).toBeFocused();
  await expect(
    other.getByText(/^1 card, 1 statement and \d+ transactions\.$/),
  ).toBeVisible();

  // The restoring device now remembers the passphrase.
  await other.getByRole('button', { name: 'Show passphrase' }).click();
  await expect(other.locator('.passphrase')).toHaveText(passphrase);

  await other.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(other.locator('.card-tile')).toHaveCount(1);
  await phone.close();
});

test('restore: a file that isn’t a backup is refused in plain words', async ({
  page,
}) => {
  await page.goto('/#/data');
  await page.locator('#backup-file-input').setInputFiles(fixture);
  await expect(page.getByRole('alert')).toHaveText(
    /^This file isn’t a Kardabra backup\./,
  );
  await expect(
    page.getByRole('button', { name: 'Choose backup file' }),
  ).toBeFocused();
});
