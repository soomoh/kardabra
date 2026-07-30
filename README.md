# Kardabra

A private, on-device credit-card statement tracker. Drag in the CSV or Excel
statements your bank exports and Kardabra shows you what you spent, what's due
and when, and what each card actually costs you in fees — **without any of your
financial data ever leaving your device.**

## Privacy model

Kardabra is local-first by design, not by promise:

- Statements are parsed **in your browser**. Nothing is uploaded.
- Everything is stored on your device in IndexedDB. There is no server, no
  account, and no network request that carries your statement data.
- The one place data could leave — the "unrecognized statement" report — is a
  file you download and choose to share, and it contains only file names and the
  parser's diagnosis, never statement contents.

What Kardabra does **not** do yet: encrypt data at rest. It lives in your
browser's IndexedDB in the clear, so treat it like any other app's local data on
a shared device.

## Quickstart

Requires Node 20+ (developed on Node 24).

```bash
npm install
npm run dev      # start the app at the printed localhost URL
```

Then open the app, go to **Import**, and drop in a statement file.

## What it understands

Kardabra reads credit-card statements as **CSV, `.xlsx`, or legacy `.xls`**, and
decides the format from the file's contents, not its extension (banks mislabel
both ways). It handles the common real-world messiness:

- delimiter auto-detection (`,`, `~`, `|`, tab, `;`) with RFC-4180 quoting;
- several date formats, including dates stored as Excel serial numbers;
- non-UTF-8 encodings (UTF-16 with a BOM, Windows-1252);
- summary blocks in a few different shapes;
- multiple credit/debit sign conventions.

Bank-account (savings) statements are recognized and declined — Kardabra tracks
credit cards only.

## Development

```bash
npm test            # run the test suite (Vitest)
npm run lint        # ESLint
npm run format      # Prettier (write) — format:check to verify
npm run build       # type-check and produce a production build
```

Tests live in `tests/`, mirroring `src/`. Statement fixtures under
`tests/fixtures/` are **synthetic** — fabricated data in real layouts — and are
regenerated with `node tests/fixtures/generate.mjs`. See
[`tests/fixtures/README.md`](tests/fixtures/README.md).

## How to add support for a new statement format

The parser is data-driven, so most new formats are a new table entry, not new
code:

- **A new date format** → add a pattern to `DATE_FORMATS` in
  `src/parser/dates.ts`.
- **A new column layout or header wording** → extend the keyword lists in
  `src/parser/table.ts` (transaction table) or `src/parser/summary.ts`
  (statement metadata).
- **A new label for a fee or payment** → extend the keyword lists in
  `src/lib/charges.ts` or `src/lib/spend.ts`.

Add a synthetic fixture reproducing the layout to `tests/fixtures/` and a test
asserting the expected parse. If a real statement isn't recognized, the Import
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

MIT — see [LICENSE](LICENSE).
