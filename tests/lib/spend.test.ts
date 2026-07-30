import { describe, it, expect } from 'vitest';
import {
  identifyPaymentIndices,
  hasPaymentKeyword,
  netSpend,
  sumOfCredits,
  billUnderpaid,
} from '../../src/lib/spend';

const purchases = [
  { payee: 'COOL COFFEE', amount: -500 },
  { payee: 'DOG PLACE', amount: -1500 },
];

describe('hasPaymentKeyword', () => {
  it('matches any of the narrow keyword list, case-insensitively', () => {
    expect(hasPaymentKeyword('BPPY CC PAYMENT')).toBe(true);
    expect(hasPaymentKeyword('bppy cc payment')).toBe(true);
    expect(hasPaymentKeyword('BBPS AUTOPAY')).toBe(true);
    expect(hasPaymentKeyword('PAYMENT RECEIVED')).toBe(true);
  });

  it('does not match a generic transfer word (narrow on purpose)', () => {
    // Deliberately narrow: 'neft'/'imps'/'transfer' also describe
    // non-payment credits (a refund routed back via NEFT). A false
    // positive here would exclude a real credit from spend and OVERSTATE
    // it — see spend.ts's header comment.
    expect(hasPaymentKeyword('NEFT CREDIT FROM FRIEND')).toBe(false);
    expect(hasPaymentKeyword('IMPS RETURN 9982')).toBe(false);
    expect(hasPaymentKeyword('TELE TRANSFER CREDIT')).toBe(false);
  });
});

describe('identifyPaymentIndices — rung 2: keyword set', () => {
  it('picks every keyword-matching credit — a SPLIT payment (two BPPY lines)', () => {
    const txns = [
      ...purchases,
      { payee: 'BPPY CC PAYMENT PART 1', amount: 10000 },
      { payee: 'CASHBACK', amount: 100 },
      { payee: 'BPPY CC PAYMENT PART 2', amount: 12380 },
    ];
    expect(identifyPaymentIndices(txns, { priorExpectedDue: null })).toEqual([
      2, 4,
    ]);
  });

  it('a single keyword credit is still returned as a one-element set', () => {
    const txns = [...purchases, { payee: 'BPPY CC PAYMENT', amount: 22380 }];
    expect(identifyPaymentIndices(txns, { priorExpectedDue: null })).toEqual([
      2,
    ]);
  });
});

describe('identifyPaymentIndices — rung 3: amount match against prior due', () => {
  it('a no-keyword credit matching the prior bill within tolerance is picked', () => {
    const txns = [
      ...purchases,
      { payee: 'TELE TRANSFER CREDIT (Ref# ST1)', amount: 22380 },
    ];
    expect(identifyPaymentIndices(txns, { priorExpectedDue: 22380 })).toEqual([
      2,
    ]);
  });

  it('closest-match wins when several credits fall in tolerance', () => {
    const txns = [
      { payee: 'TRANSFER A', amount: 22379 },
      { payee: 'TRANSFER B', amount: 22380.5 },
    ];
    expect(identifyPaymentIndices(txns, { priorExpectedDue: 22380 })).toEqual([
      1,
    ]);
  });

  it('outside tolerance: falls through to the largest-credit rung instead', () => {
    const txns = [
      { payee: 'SMALL REFUND', amount: 300 },
      { payee: 'BIG TRANSFER', amount: 5000 },
    ];
    // Neither is within 0.5%/₹1 of 22380, so rung 3 finds nothing and
    // rung 4 (largest credit) picks the 5000.
    expect(identifyPaymentIndices(txns, { priorExpectedDue: 22380 })).toEqual([
      1,
    ]);
  });
});

describe('identifyPaymentIndices — rung 4: largest-credit fallback', () => {
  it('picks the largest credit when there is no keyword and no prior due', () => {
    const txns = [
      ...purchases,
      { payee: 'CASHBACK', amount: 100 },
      { payee: 'TELE TRANSFER CREDIT', amount: 22380 },
    ];
    expect(identifyPaymentIndices(txns, { priorExpectedDue: null })).toEqual([
      3,
    ]);
  });

  it('ties keep the first occurrence (stable)', () => {
    const txns = [
      { payee: 'A', amount: 500 },
      { payee: 'B', amount: 500 },
    ];
    expect(identifyPaymentIndices(txns, { priorExpectedDue: null })).toEqual([
      0,
    ]);
  });

  it('no credits at all: empty set', () => {
    expect(
      identifyPaymentIndices(purchases, { priorExpectedDue: null }),
    ).toEqual([]);
  });
});

describe('identifyPaymentIndices — rung 1: override always wins', () => {
  it('matches each override entry to a transaction by (amount, payee)', () => {
    const txns = [
      ...purchases,
      { payee: 'BPPY CC PAYMENT', amount: 22380 }, // keyword would normally win
    ];
    // The user says the actual payment is the "CASHBACK"-shaped credit
    // that doesn't even exist here as a keyword match — override still
    // wins over the keyword rung.
    expect(
      identifyPaymentIndices(txns, {
        priorExpectedDue: null,
        override: [{ amount: 22380, payee: 'BPPY CC PAYMENT' }],
      }),
    ).toEqual([2]);
  });

  it('consumes each matching transaction at most once (duplicate amounts+payees)', () => {
    const txns = [
      { payee: 'BPPY CC PAYMENT', amount: 10000 },
      { payee: 'BPPY CC PAYMENT', amount: 10000 }, // identical value, a real second split row
    ];
    const override = [
      { amount: 10000, payee: 'BPPY CC PAYMENT' },
      { amount: 10000, payee: 'BPPY CC PAYMENT' },
    ];
    expect(
      identifyPaymentIndices(txns, { priorExpectedDue: null, override }),
    ).toEqual([0, 1]);
  });

  it('an override entry with no remaining match is skipped, not an error', () => {
    const txns = [{ payee: 'BPPY CC PAYMENT', amount: 10000 }];
    const override = [
      { amount: 10000, payee: 'BPPY CC PAYMENT' },
      { amount: 5000, payee: 'SOMETHING ELSE' }, // no matching transaction
    ];
    expect(
      identifyPaymentIndices(txns, { priorExpectedDue: null, override }),
    ).toEqual([0]);
  });

  it('an empty override array is the user’s real "no payment here" — returns []', () => {
    const txns = [...purchases, { payee: 'BPPY CC PAYMENT', amount: 22380 }];
    expect(
      identifyPaymentIndices(txns, { priorExpectedDue: null, override: [] }),
    ).toEqual([]);
  });
});

describe('netSpend — payment set excluded, every other credit nets in', () => {
  it('a refund with no keyword still reduces spend (the June regression)', () => {
    const txns = [
      ...purchases,
      { amount: 300 }, // a refund, no "refund" word
      { amount: 22380 }, // the actual payment
    ];
    // debits 2000, minus the 300 refund; the 22380 payment excluded.
    expect(netSpend(txns, [3])).toBe(1700);
  });

  it('excluding a SPLIT payment set nets in everything else', () => {
    const txns = [
      { amount: -500 },
      { amount: -1500 },
      { amount: 10000 }, // split payment part 1
      { amount: 100 }, // cashback
      { amount: 12380 }, // split payment part 2
    ];
    // debits 2000, minus the 100 cashback; both payment parts excluded.
    expect(netSpend(txns, [2, 4])).toBe(1900);
  });

  it('CATASTROPHIC-MODE PIN: a real bill payment can never drag spend down', () => {
    // The worst wrong answer: last month's ₹22,380 payment counted as
    // negative spending, halving the figure. Excluding the identified
    // payment set makes that impossible — spend stays the debits total.
    const txns = [...purchases, { amount: 22380 }];
    expect(netSpend(txns, [2])).toBe(2000);
  });

  it('no credits at all: spend is just the debits', () => {
    expect(netSpend(purchases, [])).toBe(2000);
  });

  it('debits are always spend regardless of the payment index set', () => {
    // A *debit* worded like a refund is still money out — the payment/
    // adjustment distinction only applies to credits.
    const txns = [{ amount: -50 }];
    expect(netSpend(txns, [])).toBe(50);
  });
});

describe('sumOfCredits', () => {
  it('sums every positive amount, ignores debits', () => {
    const txns = [{ amount: -500 }, { amount: 300 }, { amount: 22380 }];
    expect(sumOfCredits(txns)).toBe(22680);
  });

  it('zero for no credits at all', () => {
    expect(sumOfCredits(purchases)).toBe(0);
  });
});

describe('billUnderpaid — soft interest warning, total-credits semantics', () => {
  it('total credits matching the prior bill is not underpaid', () => {
    expect(billUnderpaid(22380, 22380)).toBe(false);
  });

  it('rounding within tolerance (paise on the bill, whole rupees credited)', () => {
    expect(billUnderpaid(7162, 7162.15)).toBe(false);
  });

  it('overcrediting into a credit balance is not a shortfall', () => {
    expect(billUnderpaid(25000, 22380)).toBe(false);
  });

  it('a partial payment with no offsetting refund is flagged', () => {
    expect(billUnderpaid(5000, 22380)).toBe(true);
  });

  it('REFUND-PLUS-PARTIAL-PAYMENT (the case this rewrite fixes): covered together, no warning', () => {
    // ₹20,000 bill; an ₹18,000 payment plus a ₹2,500 refund. The old
    // design compared only the (guessed) payment amount — 18,000 alone
    // looks like a shortfall and would have warned. Total credits
    // (18,000 + 2,500 = 20,500) actually cover the bill.
    expect(billUnderpaid(20500, 20000)).toBe(false);
  });

  it('no credits at all against a real bill is flagged', () => {
    expect(billUnderpaid(0, 22380)).toBe(true);
  });

  it('nothing to judge against (no prior bill, or nothing owed) never warns', () => {
    expect(billUnderpaid(5000, null)).toBe(false);
    expect(billUnderpaid(0, 0)).toBe(false);
  });
});
