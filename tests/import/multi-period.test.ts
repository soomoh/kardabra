/**
 * Spend is recomputed across a card's whole history in statement-period order,
 * so a cycle's bill payment is identified using the *previous* statement's
 * amount due — not just whichever credit happens to be largest. This matters
 * because a big refund can exceed the real payment; picking the largest credit
 * would exclude the wrong row and misstate spend. The result must be identical
 * no matter what order the statements were imported in.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  planImport,
  commitImport,
  type CommitUserInput,
} from '../../src/import/plan';
import {
  openKardabraDb,
  getAllCards,
  getAllStatements,
  getCyclesForCard,
} from '../../src/db/db';
import type { ParsedStatement } from '../../src/parser';

const nickname: CommitUserInput = {
  nicknames: new Map([['4321', 'My Card']]),
  dueDays: new Map(),
};
const noAsk: CommitUserInput = { nicknames: new Map(), dueDays: new Map() };

// September: 8000 of spend, no credits, and the bank states an 8000 total due.
const september: ParsedStatement = {
  fileName: 'sep.csv',
  last4: '4321',
  summary: {
    statementDateISO: '2025-09-30',
    paymentDueDateISO: '2025-10-18',
    totalDue: 8000,
  },
  transactions: [
    { dateISO: '2025-09-05', payee: 'SHOP A', amount: -6000 },
    { dateISO: '2025-09-18', payee: 'SHOP B', amount: -2000 },
  ],
};

// October: the real bill payment is an 8000 no-keyword transfer that matches
// September's due. There is ALSO a larger 12000 refund that is NOT the payment.
// Only the amount-match against the prior due picks the right one.
const october: ParsedStatement = {
  fileName: 'oct.csv',
  last4: '4321',
  summary: { statementDateISO: '2025-10-31', paymentDueDateISO: '2025-11-18' },
  transactions: [
    { dateISO: '2025-10-02', payee: 'NEFT TRANSFER', amount: 8000 },
    { dateISO: '2025-10-09', payee: 'REFUND HUGE', amount: 12000 },
    { dateISO: '2025-10-11', payee: 'SHOP C', amount: -5000 },
    { dateISO: '2025-10-20', payee: 'SHOP D', amount: -4000 },
    { dateISO: '2025-10-25', payee: 'SHOP BIG', amount: -20000 },
  ],
};

// Spend = debits(29000) − non-payment refund(12000), with the 8000 payment
// excluded = 17000. If the largest credit (the 12000 refund) were wrongly taken
// as the payment, spend would be 21000 instead — the wrong answer this pins.
const OCT_SPEND = 17000;

async function spendByPeriod(
  db: Awaited<ReturnType<typeof openKardabraDb>>,
  cardId: string,
) {
  const cycles = await getCyclesForCard(db, cardId);
  return Object.fromEntries(cycles.map((c) => [c.period, c.spend]));
}

describe('cross-statement spend recomputation', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('kardabra');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });

  it('uses the prior due to identify the payment, not the largest credit', async () => {
    const db = await openKardabraDb();
    await commitImport(
      db,
      planImport(
        [
          { fileName: 'sep.csv', parsed: september },
          { fileName: 'oct.csv', parsed: october },
        ],
        [],
        [],
      ),
      nickname,
    );

    const [card] = await getAllCards(db);
    const spend = await spendByPeriod(db, card.id);
    expect(spend['2025-09']).toBe(8000);
    expect(spend['2025-10']).toBe(OCT_SPEND);
    db.close();
  });

  it('reaches the same result when the later statement is imported first', async () => {
    const db = await openKardabraDb();

    // Import October alone. With no prior statement, its payment is guessed by
    // the largest-credit fallback (the wrong 12000 row), so its spend is off.
    await commitImport(
      db,
      planImport([{ fileName: 'oct.csv', parsed: october }], [], []),
      nickname,
    );
    const [card] = await getAllCards(db);
    const beforeSep = await spendByPeriod(db, card.id);
    expect(beforeSep['2025-10']).not.toBe(OCT_SPEND);

    // Now import September. Recomputing in period order corrects October's spend.
    const cards = await getAllCards(db);
    const statements = await getAllStatements(db);
    await commitImport(
      db,
      planImport(
        [{ fileName: 'sep.csv', parsed: september }],
        cards,
        statements,
      ),
      noAsk,
    );

    const after = await spendByPeriod(db, card.id);
    expect(after['2025-09']).toBe(8000);
    expect(after['2025-10']).toBe(OCT_SPEND);
    db.close();
  });
});
