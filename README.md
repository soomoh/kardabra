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

**Backups** (the Your data page) are one encrypted file: PBKDF2-SHA256 (600,000
rounds) derives an AES-GCM key from a five-word passphrase the app generates.
The file carries cards, statements, transactions and bills; never saved PDF
passwords, keys or settings. Restoring one replaces everything on the device,
which is also how you move Kardabra to another device.

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

## Exporting your transactions

**Your data → Export transactions** downloads every card transaction (or
those from a chosen date on) as one CSV file. It is meant for spreadsheets and
plain-text accounting tools such as [hledger](https://hledger.org), and it
isn't encrypted.

Columns, in this order. Headings are never renamed and new columns are only
added at the end, so import rules written against the file keep working.

| Column                                       | Meaning                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                         | Stable id for the transaction: the same statement imported again gives the same id.                                                                                                                                                               |
| `date`                                       | Transaction date, `YYYY-MM-DD`.                                                                                                                                                                                                                   |
| `posted`                                     | Posting date, when the statement prints one; otherwise empty.                                                                                                                                                                                     |
| `description`                                | The statement's own text, unchanged.                                                                                                                                                                                                              |
| `merchant`                                   | A cleaned name: `PAYTM*BUNDL TECHNOLOGIES PVT BANGALORE IN` → `Swiggy`. Prefixes, reference numbers and the city are removed; a known brand is named; spellings cut short by the bank are grouped; a name you gave the merchant in Insights wins. |
| `amount`                                     | Plain decimal from the card's side: money out negative (`-500.00`), money in positive (a refund or bill payment, `500.00`).                                                                                                                       |
| `currency`                                   | ISO code, such as `INR`.                                                                                                                                                                                                                          |
| `kind`                                       | `purchase`, `refund`, `cashback`, `payment` (the bill payment), `fee`, `interest`, `emi` or `forex-markup`. A fee credited back is a `fee` with a positive amount.                                                                                |
| `card_last4`, `card_nickname`, `card_issuer` | Which card. `card_issuer` is empty when the statement doesn't name its bank.                                                                                                                                                                      |
| `statement_id`, `period`                     | Which statement, and its month (`YYYY-MM`).                                                                                                                                                                                                       |
| `opening_balance`                            | The statement's previous balance, on its first row only.                                                                                                                                                                                          |
| `closing_balance`                            | What the statement says is owed, on its last row only. When the bank prints a total rounded to the rupee, the exact balance instead (opening plus the statement's rows), as long as it rounds to that total.                                      |
| `booked`                                     | The date the row counts in the card's balance: `date`, except a charge bought before the previous statement closed but billed on this one, which moves to the day after that statement. Use it as the date wherever you check balances.           |

Balances use the same sign as amounts: an amount owed is negative (`-12500.00`),
a credit balance positive. The file is UTF-8, comma-separated with standard
quoting, rows oldest first. A text cell that would start with `=`, `+`, `-` or
`@` gets a leading `'`, so a spreadsheet treats it as text instead of running
it as a formula.

### hledger

[`docs/hledger/kardabra.rules`](docs/hledger/kardabra.rules) is a starting
rules file: each card becomes `liabilities:creditcard:<nickname>`, bill
payments go to `assets:transfer:card-payments` (so they net out against your
bank import), fees and interest get their own accounts, and each statement's
closing balance becomes a balance assertion. Rows are dated by `booked`, with
the transaction date kept as the secondary date (`--date2`).

```bash
hledger import --rules kardabra.rules kardabra-transactions.csv
hledger check   # import doesn't check balance assertions; this does
```

- **Import under the same file name every time.** `hledger import` remembers
  the newest date it has imported _per file name_ and skips anything older,
  so a second import of the same history adds nothing. Under a new name
  (`kardabra-transactions (1).csv`) every row is imported again: save the new
  export over the old one.
- **Enter each card's balance before its first imported statement** yourself
  (an opening-balance transaction), or the first assertion fails.

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
- `src/backup/` — encrypted backup files and the strict parser restore runs on
  them.
- `src/lib/` — domain logic (spend, billing cycles, due status, fees, trends).
- `src/components/` — the React UI.

## License

MIT — see [LICENSE](LICENSE). Third-party attributions:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
