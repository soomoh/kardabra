/**
 * Smoke path through the real app in Chromium: empty start, import a
 * synthetic fixture, see the card on the dashboard — and prove the page makes
 * no request beyond localhost while doing it (the app's privacy promise).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
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

  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await expect(
    page.getByRole('heading', { name: 'Review and import' }),
  ).toBeVisible();
  // The statement prints its due date, so nothing is asked: Import is ready.
  await expect(page.getByText('due 2 Nov 2025')).toBeVisible();
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
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await expect(
    page.getByRole('heading', { name: 'Review and import' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();
  await page.locator('.card-tile').first().click();

  await expect(page.getByRole('heading', { name: 'Statements' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Transactions' }),
  ).toBeVisible();
  const rows = page.locator('.txn-table tbody tr');
  await expect(rows.first()).toBeVisible();

  // Choose bill payment: checkboxes appear, Cancel removes them.
  await page.getByRole('button', { name: 'Choose bill payment' }).click();
  await expect(page.getByRole('checkbox').first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);

  await page.getByRole('button', { name: 'Rename card' }).click();
  await page.getByLabel('Card nickname').fill('Travel card');
  // Enter saves and stays saved (it must not "click" the returned-to button).
  await page.getByLabel('Card nickname').press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Travel card' }),
  ).toBeVisible();
  // Closing the editor hands focus back to the button that opened it.
  await expect(page.getByRole('button', { name: 'Rename card' })).toBeFocused();

  await page
    .getByRole('combobox', { name: /^Annual fee/ })
    .selectOption('AMOUNT');
  await page.getByLabel('Annual fee amount').fill('2500');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('₹2,500.00/yr')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Edit annual fee' }),
  ).toBeFocused();
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
  await page.getByRole('link', { name: 'Import', exact: true }).click();
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

  await expect(
    page.getByRole('heading', { name: 'Review and import' }),
  ).toBeVisible();
  await expect(page.getByText('3 transactions')).toBeVisible();
  await expect(page.getByText('due 9 Nov 2025')).toBeVisible();
  // Unnamed, the card goes by the suggestion.
  await expect(
    page.getByRole('heading', { name: 'Card ····4242' }),
  ).toBeVisible();
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
  await page.getByRole('link', { name: 'Import', exact: true }).click();
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
  await page.getByRole('link', { name: 'Import', exact: true }).click();
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
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await expect(page).toHaveTitle('Import statements · Kardabra');

  // "Choose files" is reachable by Tab and opens the file picker.
  const choose = page.getByRole('button', { name: 'Choose files' });
  await choose.focus();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.keyboard.press('Enter'),
  ]);
  await chooser.setFiles(fixture);
  await expect(
    page.getByRole('heading', { name: 'Review and import' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();

  // The card's name is a real link: Enter opens it, focus moves to the
  // new page and the tab title names the card.
  const open = page.getByRole('link', {
    name: 'Card ····4321',
    exact: true,
  });
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Statements' })).toBeVisible();
  await expect(page).toHaveTitle('Card ····4321 · Kardabra');
  await expect(page.getByRole('main')).toBeFocused();
});

test('tile rename and delete hand focus back to their buttons', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();

  const trash = page.getByRole('button', { name: 'Delete Card ····4321' });
  await trash.click();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(trash).toBeFocused();

  const pencil = page.getByRole('button', { name: 'Rename Card ····4321' });
  await pencil.click();
  await page.keyboard.press('Escape');
  await expect(pencil).toBeFocused();
  await expect(page.locator('.card-nickname')).toHaveText('Card ····4321');

  // Enter saves the new name and leaves the editor closed.
  await pencil.click();
  await page.getByLabel('Nickname for Card ····4321').fill('Travel');
  await page.keyboard.press('Enter');
  await expect(page.locator('.card-nickname')).toHaveText('Travel');
  await expect(
    page.getByRole('button', { name: 'Rename Travel' }),
  ).toBeFocused();
});

test('review: a new card stands out and is named in plain view', async ({
  page,
}) => {
  // An existing card first…
  await page.goto('/#/import');
  await page
    .locator('#statement-file-input')
    .setInputFiles(
      fileURLToPath(new URL('../fixtures/axis_style.xlsx', import.meta.url)),
    );
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();

  // …then a batch with a statement for it and one new card.
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page
    .locator('#statement-file-input')
    .setInputFiles([
      fileURLToPath(new URL('../fixtures/axis_style.xlsx', import.meta.url)),
      fixture,
    ]);
  const groups = page.locator('.review-group');
  // The new card comes first, marked, with its name field showing.
  await expect(groups.first()).toHaveClass(/is-new/);
  await expect(groups.first().getByText('New card')).toBeVisible();
  await expect(
    groups.first().getByText('Likely HDFC Bank, from the file name.'),
  ).toBeVisible();
  await groups.first().getByLabel('Name').fill('Regalia');
  await expect(page.getByRole('heading', { name: 'Regalia' })).toBeVisible();

  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();
  await expect(
    page.locator('.card-nickname', { hasText: 'Regalia' }),
  ).toBeVisible();
});

test('chart: a whole month column opens its breakdown, by tap, hover or keyboard', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();

  const month = page.locator('.trends-hit').first();
  const tooltip = page.locator('.trends-tooltip');
  // Tapping anywhere in the column, even far above a thin bar, pins it.
  await month.scrollIntoViewIfNeeded();
  const box = (await month.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 10);
  await expect(tooltip).toContainText('Card ····4321');
  await expect(tooltip).toContainText('Total');
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeVisible(); // pinned: stays
  await month.click();
  await expect(tooltip).toHaveCount(0); // tap again closes

  // Keyboard: one stop per month; Enter pins (even while focus already
  // shows it), Escape closes.
  await month.focus();
  await page.keyboard.press('Enter');
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await page.getByRole('button', { name: 'View as table' }).focus();
  await page.keyboard.press('Tab'); // onto the month column
  await expect(tooltip).toBeVisible();
});

test('a missing month is shown, and an older bill claims only what is known', async ({
  page,
}) => {
  // The same card's August statement, made from October's by moving its
  // dates back two months; September is never imported.
  const october = readFileSync(fixture, 'utf8');
  const august = october
    .replace('13/10/2025', '13/08/2025')
    .replace('02/11/2025', '02/09/2025')
    .replaceAll('/09/2025', '/07/2025');
  await page.goto('/#/import');
  await page.locator('#statement-file-input').setInputFiles([
    {
      name: 'hdfc_oct.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(october),
    },
    { name: 'hdfc_aug.csv', mimeType: 'text/csv', buffer: Buffer.from(august) },
  ]);
  await page.getByRole('button', { name: 'Import 2 statements' }).click();
  await page.locator('.card-tile').first().click();

  await expect(page.locator('.statement-gap')).toHaveText(
    'Sep 2025: no statement imported',
  );
  await expect(
    // September would have shown August's payment: so it's unknown.
    page
      .locator('.statement-row')
      .nth(1)
      .getByText('Payment unknown: no Sep 2025 statement'),
  ).toBeVisible();
});

test('Back, Forward and refresh keep the page; unknown routes show the dashboard', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await expect(page).toHaveURL(/#\/import$/);
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();
  await expect(page.locator('.notice')).toBeVisible();
  await page.locator('.card-tile').first().click();
  await expect(page).toHaveURL(/#\/card\/[\w-]+$/);
  // The URL changes before the app handles its hashchange; going Back
  // before then means the app never leaves the dashboard (flaky in CI).
  await expect(page.getByRole('heading', { name: 'Statements' })).toBeVisible();
  const cardUrl = page.url();

  // Back returns to the dashboard, focus follows, the one-off import notice
  // isn't shown again.
  await page.goBack();
  await expect(page.locator('.card-grid')).toBeVisible();
  await expect(page).toHaveTitle('Dashboard · Kardabra');
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page.locator('.notice')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Refresh stays on the card.
  await page.goForward();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Statements' })).toBeVisible();
  await expect(page).toHaveTitle('Card ····4321 · Kardabra');

  await expect(page).toHaveURL(cardUrl);

  // The back link is a link too.
  await page.getByRole('link', { name: /Back to dashboard/ }).click();
  await expect(page).toHaveURL(/#\/$/);

  await page.goto('/#/no-such-page');
  await expect(page.locator('.card-grid')).toBeVisible();
  await page.goto('/#/card/gone');
  await expect(
    page.getByText("This card isn't on this device any more."),
  ).toBeVisible();

  // Deleting a card replaces its history entry: Back skips the deleted page.
  await page.goto(cardUrl);
  await page.getByRole('button', { name: 'Delete card' }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/card\/gone$/);
});

test('theme: choice applies at once, survives reload, and is kept in the settings store', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');

  // "Match system" follows the OS live.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await page.getByTitle('Dark').click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  const paper = () =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await paper()).toBe('rgb(19, 42, 32)');

  // Applied by index.html alone, before any app code (no flash): with the
  // app's entry module blocked, the page still comes up dark.
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.unroute('**/src/main.tsx');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();

  // The settings store is the record: with the mirror cleared, it restores.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.getByTitle('Match system').click();
  await expect(html).toHaveAttribute('data-theme', 'light');
});

test('review: remove a file, and a missing due day is pointed out', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Import', exact: true }).click();
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

  // The due day can be changed later on the card page, and the bill's due
  // date (projected, since the statement prints none) follows it.
  await page.locator('.card-tile').first().click();
  await expect(page.getByText('Due on day 15 of each month')).toBeVisible();
  const row = page.locator('.statement-row').first();
  const before = await row.textContent();
  await page.getByRole('button', { name: 'Change due day' }).click();
  const input = page.getByLabel('Due day', { exact: true });
  await expect(input).toBeFocused();
  await input.fill('32');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toHaveText(
    'Enter a day of the month, 1 to 31.',
  );
  await input.fill('28');
  await input.press('Enter');
  await expect(page.getByText('Due on day 28 of each month')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Change due day' }),
  ).toBeFocused();
  await expect(row).not.toHaveText(before!);
  await expect(row).toContainText('28');
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

  await page.getByRole('link', { name: 'Import', exact: true }).click();
  const zone = page.locator('.dropzone');
  await zone.dispatchEvent('dragenter');
  await expect(zone).toHaveClass(/is-dragover/);
  await expect(zone).toContainText('Drop to read them');
  await zone.dispatchEvent('dragleave');
  await expect(zone).not.toHaveClass(/is-dragover/);
});

test('which card is this: an unreadable card number asks, and the answer applies', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.locator('#statement-file-input').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Import 1 statement' }).click();
  await expect(page.locator('.card-tile')).toHaveCount(1);

  // legacy.xls carries no card number: with a card already here, ask.
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page
    .locator('#statement-file-input')
    .setInputFiles(
      fileURLToPath(new URL('../fixtures/legacy.xls', import.meta.url)),
    );
  const which = page.getByLabel('Which card is this?');
  await expect(which).toBeVisible();
  await page.getByRole('button', { name: 'Import 1 statement' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Choose the card for one statement',
  );
  await expect(which).toBeFocused();

  // The existing card already has October: the file becomes a duplicate.
  await which.selectOption({ label: 'Card ····4321' });
  await expect(
    page.locator('.badge', { hasText: 'Already imported' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();

  // Changed to a new card: it needs its due day, then imports.
  await which.selectOption({ label: 'A new card' });
  await page.getByLabel('Due day of the month').fill('15');
  await page.getByRole('button', { name: 'Import 1 statement' }).click();
  await expect(page.locator('.card-tile')).toHaveCount(2);
});
