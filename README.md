# Kardabra

A private, on-device credit-card statement tracker. Drag in the CSV or Excel
statements your bank exports, name each card and set its due day once, and
Kardabra shows you what you spent, what's due and when.

## Privacy model

Kardabra is local-first by design:

- Statements are parsed in your browser. Nothing is uploaded.
- Everything is stored on your device in IndexedDB. There is no server, account, or telemetry involved.
- In the published build, the page's Content Security Policy
  (`connect-src 'none'`) has the browser refuse any connection the page
  opens (fetch, XHR, WebSocket), not just trust the code not to.

What Kardabra does **not** do yet: encrypt statement data at rest. It lives in
your browser's IndexedDB in plaintext, so treat it like any other app's local
data on a shared device. PDF passwords you choose to remember are encrypted
with a key the browser won't export, so they never appear in a copy of the
data. That doesn't hide them from someone using your browser.

## How to use

Requires Node 22.13+ or 24+ (developed on Node 24).

```bash
npm install
npm run dev      # start the app at the printed localhost URL
```

Then open the app, go to **Import**, and drop in a statement file. Only credit card statements are supported.

## What it understands

Kardabra reads credit-card statements as **CSV, `.xlsx`, or legacy `.xls`**, and
decides the format from the file's contents.

It handles the following:

- delimiter auto-detection (`,`, `~`, `|`, tab, `;`) with RFC-4180 quoting;
- several date formats, including dates stored as Excel serial numbers;
- non-UTF-8 encodings (UTF-16 with a BOM, Windows-1252);
- multiple credit/debit sign conventions.

## Development

```bash
npm test            # run the test suite (Vitest)
npm run lint        # ESLint
npm run format      # Prettier (write) — format:check to verify
npm run build       # type-check and produce a production build
npm run test:e2e    # browser smoke test (Playwright; first run: npx playwright install chromium)
```

Tests live in `tests/`, mirroring `src/`. Statement fixtures under
`tests/fixtures/` use fabricated synthetic data in real layouts. Regenerate with `node tests/fixtures/generate.mjs`. See
[`tests/fixtures/README.md`](tests/fixtures/README.md).

## How to add support for a new statement format

The parser is data-driven, so most new formats can be supported with a new table entry:

- **A new date format** → add a pattern to `DATE_FORMATS` in
  `src/parser/dates.ts`.
- **A new column layout or header wording** → extend the keyword lists in
  `src/parser/table.ts` (transaction table) or `src/parser/summary.ts`
  (statement metadata).
- **A new label for a fee or payment** → extend the keyword lists in
  `src/lib/charges.ts` or `src/lib/spend.ts`.

Add a synthetic fixture reproducing the layout to `tests/fixtures/` and a test
asserting the expected parse. To turn a real statement into a shareable
synthetic one (same layout; names, merchants, card digits replaced; dates
shifted; amounts scaled), run `npm run anonymize -- path/to/statements/*` and read
the report it writes next to each output before sharing. For
password-protected PDFs it asks once for your name, date of birth and cards'
last four digits and tries each bank's usual password patterns; nothing you
type is stored. If a real statement isn't recognized, the Import
page can export a diagnostic report to help.

## Architecture

- `src/parser/` — pure, I/O-free parsing: bytes → a `ParsedStatement`. Format is
  chosen by magic bytes; each step (delimiter, table detection, summary,
  transactions) is a small, independently testable function.
- `src/db/` — storage over IndexedDB (via [`idb`](https://github.com/jakearchibald/idb)),
  one focused function per query/write.
- `src/import/` — the two-phase import: `planImport` decides what each file would
  do (pure), `commitImport` writes it.
- `src/lib/` — domain logic (spend, billing cycles, due status, fees, trends).
- `src/components/` — the React UI.

## License

MIT — see [LICENSE](LICENSE). Third-party attributions:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
