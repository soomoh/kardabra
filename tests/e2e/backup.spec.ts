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

  // The first backup shows its passphrase and downloads nothing until the
  // user says they've saved it.
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'Download backup' }).click();
  const offer = page.locator('.callout');
  await expect(offer).toBeFocused();
  await expect(offer).toContainText(/^Save your backup passphrase before/);
  const passphrase = (await page.locator('.passphrase').textContent())!.trim();
  expect(passphrase.split(' ')).toHaveLength(5);
  // Cancel: nothing kept, nothing downloaded, focus back on the button.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.getByRole('button', { name: 'Download backup' }),
  ).toBeFocused();
  expect(downloads).toBe(0);
  await expect(
    page.getByRole('button', { name: 'Change passphrase' }),
  ).toHaveCount(0);

  await page.getByRole('button', { name: 'Download backup' }).click();
  const shown = (await page.locator('.passphrase').textContent())!.trim();
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'I’ve saved it, download backup' })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    /^kardabra-backup-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const backupPath = await download.path();
  // The file is encrypted: no merchant, no card name readable in it.
  const text = readFileSync(backupPath, 'utf8');
  expect(JSON.parse(text).kardabra).toBe('backup');
  expect(text).not.toMatch(/HDFC|SWIGGY|AMAZON/i);
  await expect(page.locator('.inline-notice')).toBeFocused();
  await expect(page.locator('.inline-notice')).toHaveText(
    /^Your backup file is kardabra-backup-.*\.json\. It opens with your backup passphrase\.$/,
  );
  // Once saved, it's never shown again: no button reveals it.
  await expect(page.locator('.passphrase')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Show/ })).toHaveCount(0);

  // A later backup downloads straight away.
  const again = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  await again;
  await expect(page.locator('.callout')).toHaveCount(0);

  // Change passphrase offers a new one; Cancel keeps the old.
  await page.getByRole('button', { name: 'Change passphrase' }).click();
  await expect(page.locator('.callout')).toContainText(
    /^Here’s your new passphrase\./,
  );
  await expect(page.locator('.passphrase')).not.toHaveText(shown);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.getByRole('button', { name: 'Change passphrase' }),
  ).toBeFocused();
  const passphraseUsed = shown;

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
  await field.fill(passphraseUsed[0].toUpperCase() + passphraseUsed.slice(1));
  await other.getByRole('button', { name: 'Open backup' }).click();
  await expect(
    other.getByText(/^This backup from .* has 1 card and 1 statement\./),
  ).toBeVisible();
  await expect(other.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await other.getByRole('button', { name: 'Replace with backup' }).click();
  await expect(other.locator('.inline-notice')).toBeFocused();
  await expect(other.locator('.inline-notice')).toHaveText(
    /^Restored 1 card and 1 statement from the backup of/,
  );
  await expect(
    other.getByText(/^1 card, 1 statement and \d+ transactions\.$/),
  ).toBeVisible();

  // The restoring device now remembers the passphrase: its backup
  // downloads without making a new one.
  const fromPhone = other.waitForEvent('download');
  await other.getByRole('button', { name: 'Download backup' }).click();
  await fromPhone;
  await expect(other.locator('.callout')).toHaveCount(0);

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
