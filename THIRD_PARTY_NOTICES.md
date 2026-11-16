# Third-party notices

## burnrate

Kardabra's statement-password patterns (`src/lib/pdfPassword.ts`) and
bank-from-file-name rules (`src/lib/bankDetect.ts`) are based on the password
generator and bank detector in **burnrate**, re-expressed as data tables.

- Project: https://github.com/pratik-devx/burnrate
- Version: commit `a6c9267e962c2f5c84ff9367ebdca30237860d74`
- Licence: Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0

## Sumeetgpt synthetic transaction generator

Some brand names in the merchant table (`src/lib/merchantBrands.ts`) and the
idea behind the seeded test-line generator (`tests/fixtures/statementLines.ts`)
come from the merchant list in the Indian transaction categorisation
synthetic dataset's generator. Its rows and templates are not used.

- Source: https://huggingface.co/datasets/Sumeetgpt/indian-transaction-categorization-synthetic
- Licence: MIT

## EFF short word list

Backup passphrases are drawn from the EFF short word list #1
(`src/backup/words.ts`, with its one hyphenated word removed), by the
Electronic Frontier Foundation.

- Source: https://www.eff.org/dice
- Licence: Creative Commons Attribution 3.0 US —
  https://creativecommons.org/licenses/by/3.0/us/

## Runtime dependencies

Each is distributed under its own licence, included in its package:
`idb` (ISC), `react` / `react-dom` (MIT), SheetJS `xlsx` (Apache-2.0),
`pdfjs-dist` (Apache-2.0).

## Fonts

Bundled from Fontsource packages, each under the SIL Open Font License 1.1
(licence text included in its package):
Figtree (`@fontsource-variable/figtree`) and Bricolage Grotesque
(`@fontsource-variable/bricolage-grotesque`).
