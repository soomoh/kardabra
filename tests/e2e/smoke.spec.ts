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
  await expect(page.getByLabel('Card name')).toBeVisible();
  // The statement prints its due date, so nothing is asked: Import is ready.
  await expect(page.getByText('due 02-11-2025')).toBeVisible();
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();

  await expect(page.locator('.card-grid')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    'Imported 1 statement, 1 new card.',
  );
  await expect(page.getByText('₹12,345.67').first()).toBeVisible();
  expect(offsite).toEqual([]);
});

test('card page: statements, transactions, fix payment, rename, fee', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await expect(page.getByLabel('Card name')).toBeVisible();
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();
  await page.locator('.card-tile').first().click();

  await expect(page.getByRole('heading', { name: 'Statements' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Transactions' }),
  ).toBeVisible();
  const rows = page.locator('.txn-table tbody tr');
  await expect(rows.first()).toBeVisible();

  // Fix bill payment: checkboxes appear, Cancel removes them.
  await page.getByRole('button', { name: 'Fix bill payment' }).click();
  await expect(page.getByRole('checkbox').first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);

  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Card nickname').fill('Travel card');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('heading', { name: 'Travel card' }),
  ).toBeVisible();

  await page.getByLabel('Fee:').selectOption('AMOUNT');
  await page.getByLabel('Annual fee amount').fill('2500');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('₹2,500.00/yr')).toBeVisible();
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
    page.getByRole('heading', { name: 'Unlock your statements' }),
  ).toBeVisible();
  // First step asks only name and date of birth.
  await expect(page.getByLabel(/last 4 digits/)).toHaveCount(0);
  await expect(page.getByLabel('Password 1')).toHaveCount(0);
  // Fabricated cardholder of the synthetic fixture (password JANE2010).
  await page.getByLabel('Name as on your card').fill('Jane Doe');
  await page.getByLabel(/Date of birth/).fill('20/10/1990');
  await page.getByRole('button', { name: 'Unlock' }).click();

  await expect(page.getByLabel('Card name')).toBeVisible();
  await expect(page.getByText('3 transactions')).toBeVisible();
  await expect(page.getByText('due 09-11-2025')).toBeVisible();
  // A name left blank takes the suggestion shown as its placeholder.
  await expect(page.getByPlaceholder('Card ····4242')).toHaveValue('');
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();

  await expect(page.locator('.card-grid')).toBeVisible();
  await expect(page.getByText('₹12,345.67').first()).toBeVisible();
  await expect(page.getByText('Card ····4242')).toBeVisible();
  expect(offsite).toEqual([]);
});

test('files still locked after name and date of birth ask for the password', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page
    .locator('#statement-file-input')
    .setInputFiles(
      fileURLToPath(
        new URL('../fixtures/pdf_statement_locked.pdf', import.meta.url),
      ),
    );

  await page.getByLabel('Name as on your card').fill('Jane Doe');
  await page.getByLabel(/Date of birth/).fill('01/01/1990'); // wrong
  await page.getByRole('button', { name: 'Unlock' }).click();

  await expect(page.getByRole('alert')).toContainText('still locked');
  await expect(page.getByLabel(/last 4 digits/)).toBeVisible();
  const fixturePassword = 'JANE2010'; // pragma: allowlist secret
  await page.getByLabel('Password 1').fill(fixturePassword);
  await page.getByRole('button', { name: 'Unlock' }).click();

  await expect(page.getByText('3 transactions')).toBeVisible();
});

test('passwords alone, without name or date of birth, each tried on every file', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page
    .locator('#statement-file-input')
    .setInputFiles(
      fileURLToPath(
        new URL('../fixtures/pdf_statement_locked.pdf', import.meta.url),
      ),
    );

  await page
    .getByRole('button', { name: 'Have the passwords? Enter them instead' })
    .click();
  await page.getByLabel('Password 1').fill('SOMEOTHERBANK');
  await page.getByRole('button', { name: '+ Add another password' }).click();
  const fixturePassword = 'JANE2010'; // pragma: allowlist secret
  await page.getByLabel('Password 2').fill(fixturePassword);
  await page.getByRole('button', { name: 'Unlock' }).click();

  await expect(page.getByText('3 transactions')).toBeVisible();
});

test('keyboard only: choose files, open a card, focus and title follow', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page).toHaveTitle('Import statements · Kardabra');

  // "Choose files" is reachable by Tab and opens the file picker.
  const choose = page.getByRole('button', { name: 'Choose files' });
  await choose.focus();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.keyboard.press('Enter'),
  ]);
  await chooser.setFiles(fixture);
  await expect(page.getByLabel('Card name')).toBeVisible();
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();

  // The card's name is a real button: Enter opens it, focus moves to the
  // new page and the tab title names the card.
  const open = page.getByRole('button', {
    name: 'Card ····4321',
    exact: true,
  });
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Statements' })).toBeVisible();
  await expect(page).toHaveTitle('Card ····4321 · Kardabra');
  await expect(page.getByRole('main')).toBeFocused();
});

test('review: remove a file, and a missing due day is pointed out', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page
    .locator('#statement-file-input')
    .setInputFiles([
      fixture,
      fileURLToPath(new URL('../fixtures/legacy.xls', import.meta.url)),
    ]);
  await expect(
    page.getByRole('heading', { name: 'Review and import' }),
  ).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Import 2 statements' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Remove hdfc_style.csv' }).click();
  const importOne = page.getByRole('button', { name: 'Import 1 statement' });
  await expect(importOne).toBeVisible();

  // legacy.xls prints no due date: pressing Import says so and focuses it.
  await importOne.click();
  await expect(page.getByRole('alert')).toContainText('Add the due day');
  const dueDay = page.getByLabel('Due day of the month');
  await expect(dueDay).toBeFocused();
  await dueDay.fill('15');
  await importOne.click();

  await expect(page.locator('.card-tile')).toHaveCount(1);
});

test('a file dropped outside the drop zone is refused; inside, it highlights', async ({
  page,
}) => {
  await page.goto('/');
  // Outside any drop zone (the dashboard): the browser must not open it.
  const refused = await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'statement.csv'));
    const drop = new DragEvent('drop', {
      dataTransfer: data,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(drop);
    return drop.defaultPrevented;
  });
  expect(refused).toBe(true);

  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const zone = page.locator('.dropzone');
  await zone.dispatchEvent('dragenter');
  await expect(zone).toHaveClass(/is-dragover/);
  await expect(zone).toContainText('Drop to read them');
  await zone.dispatchEvent('dragleave');
  await expect(zone).not.toHaveClass(/is-dragover/);
});
