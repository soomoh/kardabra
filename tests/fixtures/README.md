# Test fixtures

Every file here is **synthetic** — fabricated names, amounts, and card numbers.
They reproduce the *shapes* real bank statement exports use so the parser can be
tested against those shapes without any real financial data ever entering the
repository. (The top-level `.gitignore` blocks every `.csv`/`.xls`/`.xlsx` in the
project and re-allows only this directory.)

Each fixture targets specific parser behavior:

| File | Format | Exercises |
|------|--------|-----------|
| `hdfc_style.csv` | CSV, `~`-delimited | delimiter auto-detection, Debit/Credit marker column (Layout 2), full summary block (dates, dues, credit limit), Indian lakh grouping, last-4 from a masked card line |
| `layout3_incell.csv` | CSV, comma | in-cell `Cr` flag (Layout 3), RFC-4180 quoted fields containing commas, mixed date formats, a statement with no recoverable card number (null last-4) |
| `savings_reject.csv` | CSV | withdrawal/deposit layout → rejected as a bank-account statement, not a card |
| `axis_style.xlsx` | Excel (ZIP) | `.xlsx` container detection, newline-packed summary cells (`label\nvalue`), `"06 Nov '25"` dates, wrapped-narration continuation row |
| `legacy.xls` | Excel (OLE2) | legacy `.xls` container detection and reading |

## Regenerating the Excel fixtures

The binary Excel and non-UTF-8 CSV files are generated; the plain CSVs are
hand-written. To rebuild the generated files after changing their layout:

```
node tests/fixtures/generate.mjs
```

The parser tests assert their full expected output explicitly (there are no
snapshot files), so after changing a fixture, update the expected values in the
corresponding `tests/parser/*.test.ts` to match and re-run `npm test`.
