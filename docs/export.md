# The transaction export

**Your data → Export transactions** saves every card transaction, or those
from a date you choose, as one CSV file. Open it in a spreadsheet, or import
it into a budgeting or accounting app such as Actual, Firefly III, GnuCash
or hledger. The file is not encrypted.

One file holds all your cards. If your app imports one account at a time,
filter the rows by `card_last4` or `card_nickname` first.

## Columns

In this order. Headings are never renamed and new columns are only added at
the end, so import settings you save against the file keep working.

| Column                                       | Meaning                                                                                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                         | A stable id for the transaction: importing the same statement again gives the same id. Use it to skip rows you already have.                                                                                                                        |
| `date`                                       | Transaction date, `YYYY-MM-DD`.                                                                                                                                                                                                                     |
| `posted`                                     | Posting date, when the statement prints one; otherwise empty.                                                                                                                                                                                       |
| `description`                                | The statement's own text, unchanged.                                                                                                                                                                                                                |
| `merchant`                                   | A clean name: `PAYTM*BUNDL TECHNOLOGIES PVT BANGALORE IN` becomes `Swiggy`. Prefixes, reference numbers and the city are removed, known brands are named, and spellings of one merchant are grouped. A name you gave the merchant in Insights wins. |
| `amount`                                     | A plain decimal from the card's side: money out is negative (`-500.00`), money in is positive (a refund or bill payment, `500.00`).                                                                                                                 |
| `currency`                                   | ISO code, such as `INR`.                                                                                                                                                                                                                            |
| `kind`                                       | `purchase`, `refund`, `cashback`, `payment` (the bill payment), `fee`, `interest`, `emi` or `forex-markup`. A fee credited back is a `fee` with a positive amount.                                                                                  |
| `card_last4`, `card_nickname`, `card_issuer` | Which card. `card_issuer` is empty when the statement doesn't name its bank.                                                                                                                                                                        |
| `statement_id`, `period`                     | Which statement, and its month (`YYYY-MM`).                                                                                                                                                                                                         |
| `opening_balance`                            | The statement's previous balance, on its first row only.                                                                                                                                                                                            |
| `closing_balance`                            | What the statement says is owed, on its last row only. When the bank prints a total rounded to the rupee, the exact balance instead (opening plus the statement's rows), as long as it rounds to that total.                                        |
| `booked`                                     | The date the row counts in the card's balance: `date`, except a charge bought before the previous statement closed but billed on this one, which moves to the day after that statement. Use it wherever you check balances.                         |

Balances use the same sign as amounts: an amount owed is negative
(`-12500.00`), a credit balance is positive.

## File format

UTF-8, comma-separated, with standard CSV quoting, rows oldest first. A text
cell that would start with `=`, `+`, `-` or `@` gets a leading `'`, so a
spreadsheet shows it as text instead of running it as a formula.

## Tips for importing

- **Bill payments are transfers, not income.** Rows of kind `payment` are
  money from your bank account paying the card. Map them to a transfer, so
  they cancel against the same payment in your bank's import.
- **Check balances with `closing_balance`.** Each statement's last row
  carries the balance the bank printed. If your app supports balance checks,
  a missing or doubled row then shows up as an error.
- **Ready-made rules:** [hledger](hledger/kardabra.rules).
