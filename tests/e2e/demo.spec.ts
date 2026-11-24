/**
 * The demo site (the app built with VITE_DEMO=1, on :4175): it opens on the
 * sample card, says so on every page, resets, and has no way to bring real
 * data in. The real app's empty dashboard points to it.
 */
import { expect, test } from '@playwright/test';

const DEMO = 'http://localhost:4175';

test('demo: opens on the sample card, resets, and takes no real data', async ({
  page,
}) => {
  await page.goto(`${DEMO}/`);
  const bar = page.locator('.demo-bar');
  await expect(bar).toContainText('This is a demo with made-up data');
  await expect(page.getByText('Sample card', { exact: true })).toBeVisible();
  // The newest bill is always due about ten days out, never overdue.
  await expect(page.getByText(/overdue/i)).toHaveCount(0);

  await page.getByRole('link', { name: 'Insights', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Insights', exact: true }),
  ).toBeVisible();
  await expect(bar).toBeVisible();
  await expect(page.locator('.insights-range')).toContainText(
    'from 4 statements.',
  );

  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Import is off in the demo' }),
  ).toBeVisible();
  await expect(page.locator('#statement-file-input')).toHaveCount(0);

  await page.getByRole('link', { name: 'Your data', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your data', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: /restore/i })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /back up/i })).toHaveCount(0);

  // A change, then Reset puts the sample back as it was.
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Mark paid' }).click();
  await expect(page.getByRole('button', { name: 'Mark paid' })).toHaveCount(0);
  await bar.getByRole('button', { name: 'Reset demo' }).click();
  await expect(bar.getByRole('status')).toHaveText('Demo reset.');
  await expect(page.getByRole('button', { name: 'Mark paid' })).toBeVisible();
  await expect(page.getByText('Sample card', { exact: true })).toHaveCount(1);

  // Reset makes a new card: from the old card's page it goes home.
  await page.getByRole('link', { name: 'Sample card' }).click();
  await expect(page.getByRole('heading', { name: 'Statements' })).toBeVisible();
  await bar.getByRole('button', { name: 'Reset demo' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('.card-grid')).toBeVisible();

  await expect(
    bar.getByRole('link', { name: 'Open Kardabra' }),
  ).toHaveAttribute('href', 'https://my.kardabra.app/');
});

test('the real app has no demo banner, and its empty dashboard links to the demo', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('link', { name: 'See a demo with made-up data' }),
  ).toHaveAttribute('href', 'https://demo.kardabra.app/');
  await expect(page.locator('.demo-bar')).toHaveCount(0);
});
