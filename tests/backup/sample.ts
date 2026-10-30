/** A small, fabricated data set shaped like what an import writes: two
 * cards, one statement each, a paid bill with a payment override. */
import type { StoredData } from '../../src/db/schema';

export function sampleData(): StoredData {
  return {
    cards: [
      {
        id: 'card-a',
        last4: '1234',
        nickname: 'Travel card',
        dueDay: 18,
        createdAt: '2026-09-01T10:00:00.000Z',
        feeLabel: { type: 'AMOUNT', amount: 2500 },
        currency: 'INR',
        pdfPasswordPattern: 'name4U+ddmm',
      },
      {
        id: 'card-b',
        last4: null,
        nickname: 'Grocery card',
        createdAt: '2026-09-02T10:00:00.000Z',
      },
    ],
    statements: [
      {
        id: 'st-a',
        cardId: 'card-a',
        period: '2026-09',
        statementDateISO: '2026-09-28',
        dueDateISO: '2026-10-18',
        totalDue: 4200.5,
        minDue: 210,
        currency: 'INR',
        skippedRows: 0,
        fingerprint: 'fp-a',
        fileName: 'statement_sep.csv',
        txnCount: 2,
        importedAt: '2026-10-01T09:00:00.000Z',
      },
      {
        id: 'st-b',
        cardId: 'card-b',
        period: '2026-09',
        fileName: 'export.xlsx',
        txnCount: 1,
        importedAt: '2026-10-01T09:05:00.000Z',
      },
    ],
    transactions: [
      {
        id: 't1',
        statementId: 'st-a',
        cardId: 'card-a',
        dateISO: '2026-09-03',
        payee: 'MERCHANT 01',
        amount: -4500.5,
      },
      {
        id: 't2',
        statementId: 'st-a',
        cardId: 'card-a',
        dateISO: '2026-09-10',
        payee: 'PAYMENT RECEIVED',
        amount: 300,
      },
      {
        id: 't3',
        statementId: 'st-b',
        cardId: 'card-b',
        dateISO: '2026-09-12',
        payee: 'MERCHANT 02',
        amount: -999,
      },
    ],
    cycles: [
      {
        cardId: 'card-a',
        period: '2026-09',
        dueDateISO: '2026-10-18',
        source: 'statement',
        totalDue: 4200.5,
        minDue: 210,
        spend: 4500.5,
        paidAt: '2026-10-15',
        paymentOverride: [{ amount: 300, payee: 'PAYMENT RECEIVED' }],
      },
      {
        cardId: 'card-b',
        period: '2026-09',
        dueDateISO: null,
        source: 'predicted',
        spend: 999,
      },
    ],
  };
}
