# Kardabra

See all your credit cards in one place: what you spent, what you owe, and
when it's due. Drop in the statements your bank sends you and Kardabra
reads them right in your browser. Nothing is uploaded, and there's no
account to create.

## What it does

- **Every card at a glance.** Each card shows its bill, its due date, and
  whether you've paid it. Cards due soon come first.
- **Spending that adds up.** Bill payments, refunds and cashback are told
  apart from what you actually spent, so the totals match your statements.
- **Insights.** Where your money went (top merchants, largest purchases),
  your subscriptions, what each card costs you in fees, GST and interest,
  how much of your credit limit you use, and charges that look like
  duplicates. Open any merchant to see the purchases behind its total, and
  give it a better name once if the bank spells it oddly.
- **Annual fee checks.** Mark a card as lifetime free or first year free,
  and Kardabra tells you if the bank charges a fee anyway. On a card you
  haven't marked, a fee it finds fills in the card's fee for you.
- **Backups you control.** Save everything to one encrypted file, protected
  by a passphrase Kardabra makes for you. Restore it on this device or a new
  one.
- **Export.** Take every transaction out as one CSV file, with clean
  merchant names, for a spreadsheet or your budgeting app. See
  [the export format](docs/export.md).

## Statements it reads

PDF, Excel (`.xlsx` and `.xls`) and CSV statements from Indian credit
cards. It works out each file's layout from its contents, so a bank it
hasn't seen before often works too.

Locked PDFs are fine. Kardabra asks for your name and date of birth once,
tries the password patterns banks use, and can remember a password for
each card. Nothing you type there is kept unless you ask it to remember.

If a statement isn't read correctly, the Import page can make a report with
the numbers masked. Look it over, then share it in an issue so the format
can be supported.

## Your privacy

- **Your statements never leave your device.** Kardabra reads them in your
  browser and stores them there. There's no server and no tracking.
- **It can't send anything, even by mistake.** The app is published with a
  browser rule that blocks every network connection it might try to make.
- **What it doesn't do:** your stored data isn't encrypted on the device, so
  anyone using your browser can see it. Treat it like the rest of your
  browser's data on a shared computer. Remembered PDF passwords are
  encrypted, and they are never included in a backup or export.
- **Erase anytime.** The Your data page removes everything Kardabra stored.

## Run it

Kardabra runs on your own computer. You need [Node.js](https://nodejs.org)
22.13 or later.

```bash
git clone https://github.com/soomoh/kardabra.git
cd kardabra
npm install
npm run build
npm run preview
```

Open the address it prints, go to **Import**, and drop in a statement.
Your data stays in the browser you use, at that address: use the same one
each time.

## Contributing

Bug reports, statement formats and code are all welcome. Please never post
a real statement: use the masked report from the Import page, or the
anonymizer described in [CONTRIBUTING.md](CONTRIBUTING.md), which also has
the setup, tests and how the code is laid out.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
