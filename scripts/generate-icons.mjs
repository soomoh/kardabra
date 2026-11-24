// Renders the app icons into public/icons/ with Playwright's Chromium: a
// "K" in the display face (Bricolage Grotesque, bundled via fontsource) on
// bottle green. Full-bleed square with the letter inside the central 60%,
// so the same image is safe as a maskable icon (cropped to a circle or
// squircle by the launcher). Run after changing the mark:
//   node scripts/generate-icons.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const font = fileURLToPath(
  new URL(
    '../node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2',
    import.meta.url,
  ),
);
// Inlined: a page set from a string can't load file:// fonts.
const fontData = readFileSync(font).toString('base64');
const out = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(out, { recursive: true });

// --primary and --surface from src/tokens.css (light theme).
const GREEN = '#23523a';
const CREAM = '#f8f0dc';

const page = (size) => `<!doctype html><html><head><style>
@font-face { font-family: B; src: url('data:font/woff2;base64,${fontData}') format('woff2'); font-weight: 200 800; }
html, body { margin: 0; }
div { width: ${size}px; height: ${size}px; background: ${GREEN}; color: ${CREAM};
  display: grid; place-items: center; font: 700 ${Math.round(size * 0.62)}px/1 B; }
span { transform: translateY(-3%); }
</style></head><body><div><span>K</span></div></body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage();
for (const [name, size] of [
  ['icon-512.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
  ['favicon-32.png', 32],
]) {
  await tab.setViewportSize({ width: size, height: size });
  await tab.setContent(page(size));
  await tab.evaluate('document.fonts.ready');
  await tab.screenshot({ path: out + name, omitBackground: false });
}
await browser.close();
