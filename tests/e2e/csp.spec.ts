/**
 * The Content Security Policy, checked on the production build (it is
 * injected at build time only): the app works under it — including the
 * pdf.js worker — and the browser refuses network requests.
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test.use({ baseURL: 'http://localhost:4174' });

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

test('the built app runs under its CSP with no violations, and fetch is refused', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  await page.goto('/');
  await expect(
    page.locator('meta[http-equiv="Content-Security-Policy"]'),
  ).toHaveAttribute('content', /connect-src 'none'/);
  // The inline theme script ran (allowed by its hash).
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme',
    /light|dark/,
  );

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
  // Both files read: the CSV, and the PDF through the pdf.js worker.
  await expect(page.getByText('3 transactions')).toHaveCount(2);

  // The rest of the app under the policy: dashboard, chart, a card page,
  // and the self-hosted fonts.
  await page.getByRole('button', { name: /^Import \d+ statements?$/ }).click();
  await expect(page.locator('.card-grid')).toBeVisible();
  await page.locator('.card-open').first().click();
  await expect(page.getByRole('link', { name: /Back/ })).toBeVisible();
  const fontsLoaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return ['Figtree', 'Bricolage Grotesque'].map((family) =>
      [...document.fonts].some(
        (f) => f.family.replace(/"/g, '') === family && f.status === 'loaded',
      ),
    );
  });
  expect(fontsLoaded).toEqual([true, true]);

  const violations = await page.evaluate(
    () => (window as unknown as { cspViolations: string[] }).cspViolations,
  );
  expect(violations).toEqual([]);

  // No network, enforced by the browser rather than by convention.
  const fetched = await page.evaluate(() =>
    fetch('/favicon.svg').then(
      () => 'allowed',
      () => 'refused',
    ),
  );
  expect(fetched).toBe('refused');
  // ...and it was the policy that refused it, not some other failure.
  const after = await page.evaluate(
    () => (window as unknown as { cspViolations: string[] }).cspViolations,
  );
  expect(after).toEqual([expect.stringMatching(/^connect-src /)]);
});
