/**
 * The transaction CSV export in a real browser, on the production build (so
 * under the CSP): download everything, then only from a date on.
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

test.use({ baseURL: 'http://localhost:4174' });

const fixture = fileURLToPath(
  new URL('../fixtures/hdfc_style.csv', import.meta.url),
);

test('export: every transaction, then from a date', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();
  await expect(page.locator('.card-grid')).toBeVisible();
  await page.getByRole('link', { name: 'Your data', exact: true }).click();

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('kardabra-transactions.csv');
  const lines = readFileSync(await download.path(), 'utf8').split('\r\n');
  expect(lines[0]).toBe(
    'id,date,posted,description,merchant,amount,currency,kind,card_last4,card_nickname,card_issuer,statement_id,period,opening_balance,closing_balance,booked',
  );
  const rows = lines.slice(1, -1).map((line) => line.split(','));
  expect(rows.map((r) => [r[1], r[3], r[4], r[5], r[7], r[8]])).toEqual([
    [
      '2025-09-20',
      'AMAZON RETAIL BLR',
      'Amazon',
      '-1500.00',
      'purchase',
      '4321',
    ],
    [
      '2025-09-22',
      'SALARY REVERSAL',
      'SALARY REVERSAL',
      '5000.00',
      'payment',
      '4321',
    ],
    ['2025-09-25', 'SWIGGY BANGALORE', 'Swiggy', '-450.50', 'purchase', '4321'],
  ]);
  // The statement's total due closes it, negative: owed.
  expect(rows[2][14]).toBe('-12345.67');
  const notice = page.locator('.inline-notice');
  await expect(notice).toBeFocused();
  await expect(notice).toHaveText(
    'Your export is kardabra-transactions.csv, with 3 transactions.',
  );

  // A date after every transaction: nothing to download, and it says so.
  let downloads = 0;
  page.on('download', () => downloads++);
  const from = page.getByLabel('From (optional)');
  await from.fill('2025-10-01');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  await expect(notice).toBeFocused();
  await expect(notice).toHaveText(/^No transactions from 1 Oct 2025 on\./);
  expect(downloads).toBe(0);

  // A half-typed date is refused, not read as "everything".
  await from.fill('');
  await expect(notice).toHaveCount(0); // a changed date clears the old result
  await from.click();
  await from.pressSequentially('22');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'The start date isn’t complete. Finish the date or clear it.',
  );
  await expect(page.getByRole('alert')).toBeFocused();
  expect(downloads).toBe(0);

  // From the 22nd: the last two only.
  await from.fill('2025-09-22');
  const fromDate = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const partial = readFileSync(await (await fromDate).path(), 'utf8');
  expect(partial.split('\r\n')).toHaveLength(4); // header, 2 rows, final CRLF
  await expect(notice).toHaveText(/with 2 transactions\.$/);
});
