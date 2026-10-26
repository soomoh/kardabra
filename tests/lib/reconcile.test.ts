import { describe, expect, it } from 'vitest';
import { reconcile, statementNeedsCheck } from '../../src/lib/reconcile';

const debit = (n: number) => ({ amount: -n });
const credit = (n: number) => ({ amount: n });

// Figures from the real-layout templates (dummy data): these must pass.
describe('statements that add up', () => {
  it('HDFC Regalia: 55462.79 − 55497.14 + 7196.29 ≈ 7162 (bank rounds)', () => {
    const txns = [
      debit(3447.95),
      credit(34.14),
      credit(55463),
      debit(508.34),
      debit(2068),
      debit(822),
      debit(350),
    ];
    expect(
      reconcile(
        {
          openingBalance: 55462.79,
          totalDue: 7162,
          paymentsTotal: 55497.14,
          purchasesTotal: 7196.29,
          chargesTotal: 0,
        },
        txns,
      ),
    ).toEqual({ status: 'ok' });
  });

  it('Axis MyZone: opening 878, one payment of 878, 2027.80 of purchases', () => {
    const txns = [
      debit(310.8),
      debit(627),
      credit(878),
      debit(573),
      debit(517),
    ];
    expect(reconcile({ openingBalance: 878, totalDue: 2027.8 }, txns)).toEqual({
      status: 'ok',
    });
  });

  it('ICICI Coral: previous 925.65 paid off, nothing due', () => {
    expect(
      reconcile({ openingBalance: 925.65, totalDue: 0 }, [credit(925.65)]),
    ).toEqual({ status: 'ok' });
  });

  it('a credit balance closes negative', () => {
    expect(
      reconcile({ openingBalance: 0, totalDue: 0, creditBalance: 500 }, [
        credit(500),
      ]),
    ).toEqual({ status: 'ok' });
  });
});

describe('statements that do not add up', () => {
  // The catastrophic misreads the check exists for.
  it('a dropped purchase row', () => {
    const r = reconcile(
      {
        openingBalance: 0,
        totalDue: 3000,
        purchasesTotal: 3000,
        paymentsTotal: 0,
      },
      [debit(1000)],
    );
    expect(r).toMatchObject({
      status: 'mismatch',
      expectedClosing: 3000,
      computedClosing: 1000,
      likely: 'debits',
    });
  });

  it('a payment read as a purchase (sign flip)', () => {
    const r = reconcile(
      {
        openingBalance: 5000,
        totalDue: 1000,
        purchasesTotal: 1000,
        paymentsTotal: 5000,
      },
      [debit(1000), debit(5000)],
    );
    expect(r).toMatchObject({ status: 'mismatch', likely: 'unclear' });
  });

  it('a refund missed on the credit side', () => {
    const r = reconcile(
      {
        openingBalance: 0,
        totalDue: 700,
        purchasesTotal: 1000,
        paymentsTotal: 300,
      },
      [debit(1000)],
    );
    expect(r).toMatchObject({ status: 'mismatch', likely: 'credits' });
  });
});

describe('nothing to check against', () => {
  it.each([[{ totalDue: 100 }], [{ openingBalance: 100 }], [{}]])(
    '%j',
    (summary) => {
      expect(reconcile(summary, [debit(100)])).toEqual({ status: 'unknown' });
    },
  );
});

// Review fix: a statement that opens in credit must not be flagged when the
// bank's own totals confirm the rows were read right…
it('accepts an opening balance that was a credit, when components agree', () => {
  expect(
    reconcile(
      {
        openingBalance: 500,
        totalDue: 500,
        purchasesTotal: 1000,
        paymentsTotal: 0,
      },
      [{ amount: -1000 }],
    ),
  ).toEqual({ status: 'ok' });
});

// …but without them a credit opening can't be told apart from a misread, so
// it still warns (the safe direction).
it('still warns on a possible credit opening with nothing to confirm it', () => {
  expect(
    reconcile({ openingBalance: 500, totalDue: 500 }, [{ amount: -1000 }]),
  ).toMatchObject({ status: 'mismatch' });
});

describe('statementNeedsCheck', () => {
  const summary = { openingBalance: 0, totalDue: 100 };
  it('flags a totals mismatch', () => {
    expect(statementNeedsCheck(summary, [{ amount: -50 }], 0)).toBe(true);
  });
  it('flags skipped rows even when totals match', () => {
    expect(statementNeedsCheck(summary, [{ amount: -100 }], 2)).toBe(true);
  });
  it('a statement that adds up, with nothing skipped, is fine', () => {
    expect(statementNeedsCheck(summary, [{ amount: -100 }], 0)).toBe(false);
  });
  it('nothing to check against is not a flag', () => {
    expect(statementNeedsCheck({}, [{ amount: -100 }], 0)).toBe(false);
  });
});
