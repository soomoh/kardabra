# Contributing to Kardabra

Kardabra is a static web app: Vite, React and TypeScript, with everything
stored in the browser's IndexedDB. There is no backend, and the app must
never make a network request at runtime. The build's Content Security
Policy (`connect-src 'none'`) enforces that, so a feature that needs the
network needs a discussion first.

## Setup

Node 22.13+ or 24+ (CI uses 24).

```bash
npm install
npm run dev            # dev server (no CSP in dev; the build has it)
npm test               # unit tests (Vitest)
npm run lint           # ESLint
npm run format         # Prettier (format:check to verify)
npm run build          # type-check, then a production build
npm run test:e2e       # browser tests (Playwright; first run: npx playwright install chromium)
```

CI runs format, lint, unit tests, the build and the browser tests. For a
UI change, `npx playwright test -c playwright.visual.config.ts` saves a
screenshot of each screen in light and dark, phone and desktop, under
`test-results-visual/`.

## Never commit a real statement

Test fixtures in `tests/fixtures/` are synthetic: fabricated data in real
layouts (see [its README](tests/fixtures/README.md)). Regenerate the binary
ones with `node tests/fixtures/generate.mjs`. The `.gitignore` blocks every
statement-shaped file outside that folder.

To share a layout from a real statement, anonymize it first:

```bash
npm run anonymize -- path/to/statements/*
```

It replaces names, merchants and card digits, shifts dates and scales
amounts, keeping the layout. Read the report it writes next to each output
before you share anything. For a locked PDF it asks once for your name,
date of birth and cards' last four digits, and stores none of them.

## Supporting a new statement format

The parser is driven by tables, so most new formats need a new entry, not
new logic:

- **A date format**: add a pattern to `DATE_FORMATS` in `src/parser/dates.ts`.
- **A column layout or header wording**: extend the keyword lists in
  `src/parser/table.ts` (the transaction table) or `src/parser/summary.ts`
  (statement dates and totals).
- **A fee or payment label**: extend the keyword lists in
  `src/lib/charges.ts` or `src/lib/spend.ts`.
- **A merchant brand**: add a line to `src/lib/merchantBrands.ts`. Order
  matters: a specific name goes before a general one.

Then add a synthetic fixture with the layout to `tests/fixtures/` and a test
that asserts the full expected parse.

## How the code is laid out

- `src/parser/`: bytes in, a parsed statement out. Pure, with no I/O. The
  format comes from the file's magic bytes, never its extension.
- `src/import/`: two phases. `planImport` decides what each file would do
  (pure), and `commitImport` writes it.
- `src/db/`: IndexedDB through [`idb`](https://github.com/jakearchibald/idb),
  one function per query or write. A schema change bumps `DB_VERSION`.
- `src/backup/`: encrypted backup files (PBKDF2-SHA256 with 600,000 rounds,
  then AES-GCM, under a generated five-word passphrase), and the strict
  parser a restore runs on them.
- `src/lib/`: the domain logic: spend, billing cycles, due dates, fees,
  merchant names, Insights. Derived when read, never stored, so a fix
  applies to statements already imported.
- `src/components/`: the React UI, with hash routing (`#/`, `#/import`,
  `#/data`, `#/card/:id`, `#/insights`).

Amounts follow one sign rule everywhere: money out is negative, money in is
positive.

## Pull requests

Keep each one to a single change, with tests. A bug fix includes a test
that fails without it.
