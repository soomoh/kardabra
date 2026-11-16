/**
 * The Insights page over four months of one card: every section answers
 * from the imported statements, the range and card filter work, and the
 * card page links to its own insights.
 */
import { expect, test, type Page } from '@playwright/test';
import { insightsStatements } from './insightsData';

async function importFourMonths(page: Page) {
  await page.goto('/#/import');
  await page.locator('#statement-file-input').setInputFiles(insightsStatements);
  await page.getByRole('button', { name: 'Import 4 statements' }).click();
  await expect(page.locator('.card-grid, .settled-list').first()).toBeVisible();
}

test('insights answer from the statements, over the chosen months', async ({
  page,
}) => {
  await page.goto('/#/insights');
  await expect(page.getByText('Import your statements to see')).toBeVisible();

  await importFourMonths(page);
  await page.getByRole('link', { name: 'Insights', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Insights' })).toBeVisible();
  await expect(page.locator('.insights-range')).toHaveText(
    'Jul 2025 to Oct 2025, from 4 statements.',
  );

  const where = page.getByRole('table', { name: 'Top merchants' });
  // Amazon's ₹200 refund comes off its purchases.
  await expect(where.getByRole('row').nth(1)).toContainText('Croma');
  await expect(where.getByRole('row', { name: /Amazon/ })).toContainText(
    '₹10,000.00',
  );

  const subs = page.getByRole('table', { name: 'Subscriptions' });
  await expect(subs.getByRole('row', { name: /Netflix/ })).toContainText(
    'Up from ₹499.00',
  );
  await expect(page.getByText('a month goes to 2 monthly')).toBeVisible();

  // Two spellings of one shop's web address are one merchant.
  await expect(where.getByRole('row', { name: /BigBasket/ })).toContainText(
    /^BigBasket\s*2/,
  );

  const costs = page.locator('.cost-list');
  const row = (label: RegExp) =>
    costs.locator('.cost-row').filter({ hasText: label });
  await expect(row(/^Annual fee/)).toContainText('₹499.00');
  await expect(row(/^Other fees/)).toContainText('₹700.00');
  await expect(row(/^GST/)).toContainText('₹126.00');
  await expect(row(/^Interest/)).toContainText('₹450.00');
  // Markup and its GST, plus three DCC lines.
  await expect(row(/^Foreign currency markup/)).toContainText('₹284.44');
  await expect(row(/^Cashback/)).toContainText('+₹50.00');
  // A fee opens to the lines that charged it.
  await row(/^Other fees/)
    .locator('summary')
    .click();
  await expect(
    page.getByRole('table', { name: 'Other fees: lines' }),
  ).toContainText('LATE PAYMENT FEE');
  // The DCC markup recurs monthly but is a charge, not a subscription.
  await expect(subs).not.toContainText('DCC');

  await expect(page.locator('.credit-pct')).toHaveText('36%');
  await expect(page.getByText(/more than 30% of a limit/)).toBeVisible();

  await expect(
    page.getByRole('table', { name: 'Possible duplicates' }),
  ).toContainText('COOL COFFEE');

  // The last 3 months leave July out.
  await page.getByText('Last 3 months').click();
  await expect(page.locator('.insights-range')).toHaveText(
    'Aug 2025 to Oct 2025, from 3 statements.',
  );
  await expect(where.getByRole('row', { name: /Amazon/ })).toContainText(
    '₹5,500.00',
  );
});

test('the card page links to its own insights, and Back returns', async ({
  page,
}) => {
  await importFourMonths(page);
  await page.locator('.card-open').first().click();
  await page.getByRole('link', { name: 'Spend insights' }).click();
  await expect(page).toHaveURL(/#\/insights\/[^/]+$/);
  await expect(page.getByLabel('Card')).not.toHaveValue('');

  // selectOption doesn't focus the select; a keyboard user's would be.
  await page.getByLabel('Card').focus();
  await page.getByLabel('Card').selectOption({ label: 'All cards' });
  await expect(page).toHaveURL(/#\/insights$/);
  // Same page, other card: focus stays on the select that changed it.
  await expect(page.getByLabel('Card')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/#\/insights\/[^/]+$/);
  await page.getByRole('link', { name: /Back to/ }).click();
  await expect(page.getByRole('heading', { name: 'Statements' })).toBeVisible();
});
