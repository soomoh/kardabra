import { describe, expect, test } from 'vitest';
import type {
  CardRecord,
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../../src/db/schema';
import {
  buildInsights,
  creditUsed,
  findSubscriptions,
  isPriceRise,
  labelTransactions,
  monthlyCommitted,
  possibleDuplicates,
  resolveRange,
  whatItCosts,
  whereItWent,
  type InsightsInput,
  type LabelledTxn,
} from '../../src/lib/insights';

/** A tiny store: `months` maps period → that statement's lines
 * [day, payee, amount]. Every statement gets a cycle row. */
function store(
  cards: Record<
    string,
    {
      months: Record<string, [number, string, number][]>;
      limit?: number;
      due?: Record<string, number>;
    }
  >,
): InsightsInput {
  const input: InsightsInput = {
    cards: [],
    statements: [],
    transactions: [],
    cycles: [],
  };
  for (const [cardId, spec] of Object.entries(cards)) {
    input.cards.push({
      id: cardId,
      last4: null,
      nickname: cardId,
      createdAt: '2026-01-01T00:00:00Z',
    } satisfies CardRecord);
    for (const [period, lines] of Object.entries(spec.months)) {
      const id = `${cardId}-${period}`;
      input.statements.push({
        id,
        cardId,
        period,
        totalDue: spec.due?.[period],
        creditLimit: spec.limit,
        fileName: `${id}.csv`,
        txnCount: lines.length,
        importedAt: '2026-01-01T00:00:00Z',
      } satisfies StatementRecord);
      input.cycles.push({
        cardId,
        period,
        dueDateISO: null,
        source: 'statement',
      } satisfies CycleRecord);
      lines.forEach(([day, payee, amount], i) => {
        input.transactions.push({
          id: `${id}-${i}`,
          statementId: id,
          cardId,
          dateISO: `${period}-${String(day).padStart(2, '0')}`,
          payee,
          amount,
        } satisfies TransactionRecord);
      });
    }
  }
  return input;
}

function periodsOf(input: InsightsInput): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const s of input.statements) {
    const set = map.get(s.cardId) ?? new Set();
    set.add(s.period);
    map.set(s.cardId, set);
  }
  return map;
}

function subsOf(input: InsightsInput) {
  return findSubscriptions(labelTransactions(input), periodsOf(input));
}

describe('labelTransactions', () => {
  test('labels the bill payment from the walk, and the rest by kind', () => {
    const txns = labelTransactions(
      store({
        a: {
          months: {
            '2026-03': [
              [2, 'PAYMENT RECEIVED THANK YOU', 5000],
              [5, 'COOL COFFEE BANGALORE', -300],
              [6, 'ANNUAL FEE', -499],
              [7, 'COOL COFFEE BANGALORE', 100],
            ],
          },
        },
      }),
    );
    expect(txns.map((t) => [t.merchant, t.kind])).toEqual([
      ['PAYMENT RECEIVED THANK YOU', 'payment'],
      ['COOL COFFEE', 'purchase'],
      ['ANNUAL FEE', 'fee'],
      ['COOL COFFEE', 'refund'],
    ]);
  });
});

describe('resolveRange', () => {
  test.each([
    // The newest statement anchors the range, not today's date
    [
      ['2025-01', '2025-06', '2025-08'],
      '3',
      { from: '2025-06', to: '2025-08' },
    ],
    // Crosses a year
    [['2024-11', '2025-01'], '3', { from: '2024-11', to: '2025-01' }],
    // Never before the first statement
    [['2025-07', '2025-08'], '12', { from: '2025-07', to: '2025-08' }],
    [['2025-08', '2023-02'], 'all', { from: '2023-02', to: '2025-08' }],
  ] as const)('%j, last %s → %j', (periods, choice, expected) => {
    expect(resolveRange([...periods], choice)).toEqual(expected);
  });

  test('no statements, no range', () => {
    expect(resolveRange([], '3')).toBeNull();
  });
});

describe('whereItWent', () => {
  test('nets refunds against their merchant and ranks by what is left', () => {
    const txns = labelTransactions(
      store({
        a: {
          months: {
            '2026-03': [
              // A real bill payment, or the largest credit would be taken
              // for it (detectPayment's last rung).
              [1, 'PAYMENT RECEIVED THANK YOU', 9000],
              [1, 'AMAZON PAY INDIA', -3000],
              [2, 'COOL COFFEE BANGALORE', -500],
              [3, 'COOL COFFEE BANGALORE', -400],
              [4, 'AMAZON PAY INDIA', 2500], // refund
              [5, 'FUEL SURCHARGE', -40], // a fee, not spending
              [6, 'BOOKSHOP', -200],
              [7, 'BOOKSHOP', 200], // fully refunded: drops out
            ],
          },
        },
      }),
    );
    const result = whereItWent(txns);
    expect(
      result.merchants.map(({ lines, ...m }) => ({
        ...m,
        lines: lines.map((t) => [t.dateISO, t.payee, t.amount]),
      })),
    ).toEqual([
      {
        merchant: 'COOL COFFEE',
        net: 900,
        purchases: 2,
        lines: [
          ['2026-03-03', 'COOL COFFEE BANGALORE', -400],
          ['2026-03-02', 'COOL COFFEE BANGALORE', -500],
        ],
      },
      {
        merchant: 'Amazon',
        net: 500,
        purchases: 1,
        lines: [
          ['2026-03-04', 'AMAZON PAY INDIA', 2500], // the refund behind the net
          ['2026-03-01', 'AMAZON PAY INDIA', -3000],
        ],
      },
    ]);
    expect(result.total).toBe(1400);
    expect(result.largest.map((t) => -t.amount)).toEqual([3000, 500, 400, 200]);
  });

  test('spellings that start the same merchant name are one merchant', () => {
    const rows: [number, string, number][] = [
      [1, 'PAYMENT RECEIVED THANK YOU', 90000],
      // Every Tata Payments spelling seen so far
      [2, 'TataPayments Limited', -100],
      [2, 'TataPayments Limited', -100],
      [3, 'TATA PAYMENTS LIMITEDBMUMBAI', -100],
      [3, 'TATA PAYMENTS LIMITEDMUMBAI', -100],
      [4, 'TataPaymentsLimitedMumbai', -100],
      [4, 'TATAPAYMENTS', -100],
      [5, 'TATA PAYMENTS PVT LTD', -100],
      [5, 'TATA PAYMENTS PR', -100],
      // Cut short by the bank's fixed-width field
      [6, 'ORBGEN TECHNOLOGIES', -200],
      [6, 'ORBGEN TECHNOLOGIES PR', -200],
      // A stem under 8 letters joins nothing
      [7, 'ACME LTD', -300],
      [7, 'ACME STORES', -300],
      [8, 'TATA CLIQ', -400],
      [8, 'TATA NEU BROADBAND', -400],
      // Brands don't join by prefix: the brand table groups them
      [9, 'RELIANCE', -500],
      [9, 'RELIANCE DIGITAL', -500],
      [9, 'RELIANCE TRENDS', -500],
    ];
    const txns = labelTransactions(
      store({ a: { months: { '2026-03': rows } } }),
    );
    const names = Object.fromEntries(
      txns.map((t) => [t.payee, `${t.merchant} / ${t.merchantKey}`]),
    );
    expect(names).toEqual({
      'PAYMENT RECEIVED THANK YOU':
        'PAYMENT RECEIVED THANK YOU / PAYMENTRECEIVEDTHANKYOU',
      'TataPayments Limited': 'TataPayments Limited / TATAPAYMENTS',
      'TATA PAYMENTS LIMITEDBMUMBAI': 'TataPayments Limited / TATAPAYMENTS',
      'TATA PAYMENTS LIMITEDMUMBAI': 'TataPayments Limited / TATAPAYMENTS',
      TataPaymentsLimitedMumbai: 'TataPayments Limited / TATAPAYMENTS',
      TATAPAYMENTS: 'TataPayments Limited / TATAPAYMENTS',
      'TATA PAYMENTS PVT LTD': 'TataPayments Limited / TATAPAYMENTS',
      'TATA PAYMENTS PR': 'TataPayments Limited / TATAPAYMENTS',
      'ORBGEN TECHNOLOGIES': 'ORBGEN TECHNOLOGIES / ORBGENTECHNOLOGIES',
      'ORBGEN TECHNOLOGIES PR': 'ORBGEN TECHNOLOGIES / ORBGENTECHNOLOGIES',
      'ACME LTD': 'ACME LTD / ACME',
      'ACME STORES': 'ACME STORES / ACMESTORES',
      'TATA CLIQ': 'Tata CLiQ / TATACLIQ',
      'TATA NEU BROADBAND': 'TATA NEU BROADBAND / TATANEUBROADBAND',
      RELIANCE: 'RELIANCE / RELIANCE',
      'RELIANCE DIGITAL': 'Reliance Digital / RELIANCEDIGITAL',
      'RELIANCE TRENDS': 'Reliance Trends / RELIANCETRENDS',
    });
  });

  test('grouping spans cards, and the stem’s spelling names the group', () => {
    const txns = labelTransactions(
      store({
        a: {
          months: {
            '2026-03': [
              [1, 'PAYMENT RECEIVED THANK YOU', 9000],
              [2, 'ORBGEN TECHNOLOGIES PR', -200],
              [2, 'ORBGEN TECHNOLOGIES PR', -200],
            ],
          },
        },
        b: {
          months: { '2026-03': [[4, 'ORBGEN TECHNOLOGIES', -200]] },
        },
      }),
    );
    expect(
      txns.filter((t) => t.kind === 'purchase').map((t) => t.merchant),
    ).toEqual([
      'ORBGEN TECHNOLOGIES',
      'ORBGEN TECHNOLOGIES',
      'ORBGEN TECHNOLOGIES',
    ]);
    // Merged spellings are one merchant to the other insights too.
    expect(whereItWent(txns).merchants).toHaveLength(1);
    expect(possibleDuplicates(txns)).toHaveLength(1);
  });

  test('a merchant with only refunds is not a top merchant', () => {
    const txns = labelTransactions(
      store({ a: { months: { '2026-03': [[1, 'SOME SHOP', 300]] } } }),
    );
    expect(whereItWent(txns).merchants).toEqual([]);
  });
});

describe('findSubscriptions', () => {
  const monthly = (amounts: number[], start = 1) =>
    Object.fromEntries(
      amounts.map((amount, i) => [
        `2026-${String(start + i).padStart(2, '0')}`,
        [[3, 'NETFLIX.COM', -amount]] as [number, string, number][],
      ]),
    );

  test('three months at the same price is a monthly subscription', () => {
    expect(subsOf(store({ a: { months: monthly([649, 649, 649]) } }))).toEqual([
      {
        cardId: 'a',
        merchant: 'Netflix',
        cadence: 'monthly',
        amount: 649,
        previousAmount: undefined,
        since: '2026-01',
        lastPeriod: '2026-03',
      },
    ]);
  });

  test('two months is not enough', () => {
    expect(subsOf(store({ a: { months: monthly([649, 649]) } }))).toEqual([]);
  });

  test('a rise of more than ₹10 and 5% is flagged; a small wobble is not', () => {
    const [rise] = subsOf(store({ a: { months: monthly([499, 499, 649]) } }));
    expect(rise.previousAmount).toBe(499);
    const [wobble] = subsOf(
      store({ a: { months: monthly([999, 999, 1005]) } }),
    );
    expect(wobble.previousAmount).toBeUndefined();
    expect(isPriceRise(100, 109)).toBe(false); // 9% but under ₹10
    expect(isPriceRise(1000, 1040)).toBe(false); // ₹40 but under 5%
    expect(isPriceRise(1000, 1060)).toBe(true);
  });

  test('an older price change keeps the subscription and its start', () => {
    const [sub] = subsOf(
      store({ a: { months: monthly([499, 499, 499, 649, 649, 649]) } }),
    );
    expect(sub).toMatchObject({ since: '2026-01', amount: 649 });
    expect(sub.previousAmount).toBeUndefined();
  });

  test('the month after a rise still shows it, with the old price', () => {
    const [sub] = subsOf(
      store({ a: { months: monthly([499, 499, 499, 649, 649]) } }),
    );
    expect(sub).toMatchObject({
      amount: 649,
      previousAmount: 499,
      since: '2026-01',
    });
  });

  test('a big rise or a drop keeps the subscription', () => {
    const [rise] = subsOf(store({ a: { months: monthly([199, 199, 349]) } }));
    expect(rise).toMatchObject({ amount: 349, previousAmount: 199 });
    const [drop] = subsOf(
      store({ a: { months: monthly([649, 649, 199 * 2]) } }),
    );
    expect(drop).toMatchObject({ amount: 398, previousAmount: undefined });
  });

  test('a tripled amount is a different purchase', () => {
    expect(subsOf(store({ a: { months: monthly([300, 300, 900]) } }))).toEqual(
      [],
    );
  });

  test('a one-off at another price before it is not part of "since"', () => {
    const [sub] = subsOf(
      store({ a: { months: monthly([200, 1000, 1000, 1000]) } }),
    );
    expect(sub).toMatchObject({ since: '2026-02', amount: 1000 });
  });

  test('monthlyCommitted adds the monthly ones only', () => {
    const subs = subsOf(
      store({
        a: {
          months: {
            ...monthly([649, 649, 649], 3),
            '2025-04': [[10, 'AMAZON PRIME', -1499]],
            '2026-04': [
              [3, 'NETFLIX.COM', -649],
              [10, 'AMAZON PRIME', -1499],
            ],
          },
        },
      }),
    );
    expect(subs.map((s) => s.cadence)).toEqual(['monthly', 'yearly']);
    expect(monthlyCommitted(subs)).toBe(649);
  });

  test('amounts that wander are shopping, not a subscription', () => {
    expect(subsOf(store({ a: { months: monthly([300, 900, 450]) } }))).toEqual(
      [],
    );
  });

  test('two charges in one month break the run', () => {
    const months = monthly([649, 649, 649]);
    months['2026-02'].push([20, 'NETFLIX.COM', -649]);
    expect(subsOf(store({ a: { months } }))).toEqual([]);
  });

  test('a stopped subscription is not listed', () => {
    const months = { ...monthly([649, 649, 649]), '2026-06': [] };
    expect(subsOf(store({ a: { months } }))).toEqual([]);
  });

  test('spellings of one merchant are one subscription', () => {
    const [sub, ...rest] = subsOf(
      store({
        a: {
          months: {
            '2026-01': [[3, 'TataPaymentsLimitedMumbai', -399]],
            '2026-02': [[3, 'TATAPAYMENTS', -399]],
            '2026-03': [[3, 'TataPaymentsLimited', -399]],
          },
        },
      }),
    );
    expect(rest).toEqual([]);
    // The most common spelling; on a tie, the one in words
    expect(sub).toMatchObject({
      merchant: 'TataPayments Limited',
      amount: 399,
    });
  });

  test('a yearly charge 12 months apart', () => {
    const subs = subsOf(
      store({
        a: {
          months: {
            '2025-03': [[10, 'AMAZON PRIME', -1499]],
            '2025-09': [[1, 'BOOKSHOP', -100]],
            '2026-03': [[10, 'AMAZON PRIME', -1499]],
            '2026-04': [],
          },
        },
      }),
    );
    expect(subs).toEqual([
      expect.objectContaining({
        cadence: 'yearly',
        amount: 1499,
        since: '2025-03',
        lastPeriod: '2026-03',
      }),
    ]);
  });

  test('subscriptions are per card', () => {
    const subs = subsOf(
      store({
        a: { months: monthly([649, 649]) },
        b: { months: { '2026-03': [[3, 'NETFLIX.COM', -649]] } },
      }),
    );
    expect(subs).toEqual([]);
  });
});

describe('whatItCosts', () => {
  test('annual fee, other fees and GST apart; interest; markup; cashback; EMIs aside', () => {
    const txns = labelTransactions(
      store({
        a: {
          months: {
            '2026-03': [
              [1, 'PAYMENT RECEIVED THANK YOU', 9000],
              [1, 'FUEL SURCHARGE', -40],
              [1, 'PETRO SURCHARGE WAIVER', 30],
              [2, 'LATE PAYMENT FEE', -700],
              [2, 'IGST ON LATE FEE', -126],
              [2, 'IGST-VPS2526123456789-RATE 18.0 -27', -97.17],
              [2, 'RENEWAL MEMBERSHIP FEE', -499],
              [2, 'ANNUAL FEE CHARGED (EXCL TAX 539.82)', -539.82],
              [2, 'REDEMPTION PROC FEE', -99],
              [3, 'FINANCE CHARGES', -1200],
              [4, 'CONSOLIDATED FCY MARKUP FEE', -87.5],
              [4, 'GST ON FOREX MARKUP', -15.75],
              [4, '1.75% on all DCC Transaction', -42.5],
              [5, '10% Swiggy Cashback', 50],
              [6, 'EMI 3/12 AMAZON PAY INDIA', -2500],
              [6, 'EMI INTEREST', -310],
              [7, 'COOL COFFEE', -500],
            ],
          },
        },
      }),
    );
    const costs = whatItCosts(txns);
    expect(costs.amounts).toEqual({
      annualFee: 1038.82,
      otherFees: 809, // 40 - 30 + 700 + 99
      gst: 223.17,
      interest: 1200,
      forexMarkup: 145.75,
      cashback: -50, // money back
    });
    expect(costs.charges).toBe(3416.74);
    // The lines behind each figure, so a fee can be traced; no EMI lines
    expect(costs.lines.annualFee.map((t) => t.payee)).toEqual([
      'RENEWAL MEMBERSHIP FEE',
      'ANNUAL FEE CHARGED (EXCL TAX 539.82)',
    ]);
    expect(costs.lines.gst.map((t) => t.payee)).toEqual([
      'IGST ON LATE FEE',
      'IGST-VPS2526123456789-RATE 18.0 -27',
    ]);
    expect(
      Object.values(costs.lines)
        .flat()
        .some((t) => t.kind === 'emi'),
    ).toBe(false);
  });

  test('a fee mentioning GST is the fee; an unnamed waiver nets its annual fee', () => {
    const costs = whatItCosts(
      labelTransactions(
        store({
          a: {
            months: {
              '2026-03': [
                [1, 'PAYMENT RECEIVED THANK YOU', 9000],
                [2, 'ANNUAL FEE (INCL GST)', -589.82],
                [3, 'RENEWAL MEMBERSHIP FEE', -499],
                [4, 'FEE WAIVER', 499],
                [5, 'CGST', -45],
                [5, 'SGST', -45],
              ],
            },
          },
        }),
      ),
    );
    expect(costs.amounts).toMatchObject({
      annualFee: 589.82,
      otherFees: 0,
      gst: 90,
    });
  });

  test('an empty row is 0, not -0', () => {
    expect(Object.is(whatItCosts([]).amounts.cashback, 0)).toBe(true);
  });
});

test('a waiver for a fee charged before the range nets below zero', () => {
  const insights = buildInsights(
    store({
      a: {
        months: {
          '2026-01': [
            [1, 'PAYMENT RECEIVED THANK YOU', 100],
            [2, 'ANNUAL FEE', -499],
          ],
          '2026-02': [[1, 'PAYMENT RECEIVED THANK YOU', 100]],
          '2026-03': [[1, 'PAYMENT RECEIVED THANK YOU', 100]],
          '2026-04': [
            [1, 'PAYMENT RECEIVED THANK YOU', 100],
            [2, 'ANNUAL FEE REVERSAL', 499],
          ],
        },
      },
    }),
    '3',
  )!;
  // The sign survives: a credit, never a charge.
  expect(insights.costs.amounts.annualFee).toBe(-499);
});

describe('creditUsed', () => {
  test('each card answers from its own newest statement', () => {
    const input = store({
      a: { limit: 1000, due: { '2026-03': 100 }, months: { '2026-03': [] } },
      b: { limit: 1000, due: { '2025-11': 500 }, months: { '2025-11': [] } },
    });
    expect(
      creditUsed(input.statements, { from: '2025-01', to: '2026-03' }).map(
        (c) => [c.cardId, c.period],
      ),
    ).toEqual([
      ['b', '2025-11'],
      ['a', '2026-03'],
    ]);
  });

  test('never answers from an older statement, nor from a zero limit', () => {
    const input = store({
      a: {
        due: { '2026-02': 50000, '2026-03': 42000 },
        months: { '2026-02': [], '2026-03': [] },
      },
      b: { limit: 0, due: { '2026-03': 100 }, months: { '2026-03': [] } },
    });
    input.statements.find((s) => s.period === '2026-02')!.creditLimit = 100000;
    expect(
      creditUsed(input.statements, { from: '2026-01', to: '2026-03' }),
    ).toEqual([]);
  });

  test("each card's newest statement in range with both figures", () => {
    const input = store({
      a: {
        limit: 100000,
        due: { '2026-02': 50000, '2026-03': 42000 },
        months: { '2026-02': [], '2026-03': [] },
      },
      b: { months: { '2026-03': [] }, due: { '2026-03': 1000 } }, // no limit
    });
    expect(
      creditUsed(input.statements, { from: '2026-01', to: '2026-03' }),
    ).toEqual([
      {
        cardId: 'a',
        period: '2026-03',
        totalDue: 42000,
        creditLimit: 100000,
        ratio: 0.42,
      },
    ]);
  });

  test('a credit balance is no credit used', () => {
    const input = store({
      a: { limit: 50000, due: { '2026-03': -200 }, months: { '2026-03': [] } },
    });
    const [use] = creditUsed(input.statements, {
      from: '2026-03',
      to: '2026-03',
    });
    expect(use.ratio).toBe(0);
  });
});

describe('possibleDuplicates', () => {
  test('same card, merchant, amount and day', () => {
    const txns: LabelledTxn[] = labelTransactions(
      store({
        a: {
          months: {
            '2026-03': [
              [5, 'COOL COFFEE BANGALORE', -300],
              [5, 'COOL COFFEE MUMBAI', -300], // same merchant once cleaned
              [5, 'COOL COFFEE', -301], // different amount
              [6, 'COOL COFFEE', -300], // different day
            ],
          },
        },
        b: { months: { '2026-03': [[5, 'COOL COFFEE', -300]] } }, // other card
        c: {
          months: {
            '2026-03': [
              [1, 'PAYMENT RECEIVED THANK YOU', 900],
              [5, 'COOL COFFEE', 300], // refunds are not purchases
              [5, 'COOL COFFEE', 300],
            ],
          },
        },
      }),
    );
    expect(possibleDuplicates(txns)).toEqual([
      {
        cardId: 'a',
        merchant: 'COOL COFFEE',
        dateISO: '2026-03-05',
        amount: 300,
        count: 2,
      },
    ]);
  });

  test('a refund of the same amount cancels one of the charges', () => {
    const txns = labelTransactions(
      store({
        a: {
          months: {
            '2026-01': [
              [1, 'PAYMENT RECEIVED THANK YOU', 20000],
              // Charged twice, reversed once on the day: one charge.
              [1, 'EMI CAS*SwiggyBengaluru', -5066],
              [1, 'EMI CAS*SwiggyBengaluru', -5066],
              [1, 'CAS*SwiggyBengaluru', 5066],
            ],
          },
        },
      }),
    );
    expect(txns.map((t) => [t.merchantKey, t.kind])).toEqual([
      ['PAYMENTRECEIVEDTHANKYOU', 'payment'],
      ['SWIGGY', 'purchase'],
      ['SWIGGY', 'purchase'],
      ['SWIGGY', 'refund'],
    ]);
    expect(possibleDuplicates(txns)).toEqual([]);
  });

  test('a reversal up to 7 days later counts; 8 days later does not', () => {
    const txns = labelTransactions(
      store({
        a: {
          months: {
            '2026-03': [
              [1, 'PAYMENT RECEIVED THANK YOU', 20000],
              [3, 'COOL COFFEE', -300],
              [3, 'COOL COFFEE', -300],
              [10, 'COOL COFFEE', 300], // 7 days on: cancels one
              [12, 'BOOKSHOP', -500],
              [12, 'BOOKSHOP', -500],
              [20, 'BOOKSHOP', 500], // 8 days on: a separate refund
              [14, 'TEA HOUSE', -90],
              [14, 'TEA HOUSE', -90],
              [14, 'TEA HOUSE', -90],
              [14, 'TEA HOUSE', 90], // three charges, one reversal: still two
              [13, 'TEA HOUSE', 90], // before the charges: not a reversal
              [28, 'NOODLE BAR', -400],
              [28, 'NOODLE BAR', -400],
              [29, 'NOODLE BAR', 401], // another amount
              [29, 'NOODLE PLACE', 400], // another merchant
              [30, 'GYM', -900],
              [30, 'GYM', -900],
            ],
            // Across the month end: still within 7 days
            '2026-04': [
              [1, 'PAYMENT RECEIVED THANK YOU', 5000],
              [2, 'GYM', 900],
            ],
          },
        },
        b: { months: { '2026-03': [[29, 'NOODLE BAR', 400]] } }, // other card
      }),
    );
    expect(possibleDuplicates(txns)).toEqual([
      {
        cardId: 'a',
        merchant: 'NOODLE BAR',
        dateISO: '2026-03-28',
        amount: 400,
        count: 2,
      },
      {
        cardId: 'a',
        merchant: 'TEA HOUSE',
        dateISO: '2026-03-14',
        amount: 90,
        count: 2,
      },
      {
        cardId: 'a',
        merchant: 'BOOKSHOP',
        dateISO: '2026-03-12',
        amount: 500,
        count: 2,
      },
    ]);
  });
});

describe('buildInsights', () => {
  const input = store({
    a: {
      months: {
        '2026-01': [[3, 'BOOKSHOP', -1000]],
        '2026-02': [[3, 'BOOKSHOP', -2000]],
        '2026-03': [[3, 'BOOKSHOP', -3000]],
        '2026-04': [[3, 'BOOKSHOP', -4000]],
      },
    },
    b: { months: { '2026-04': [[3, 'COOL COFFEE', -50]] } },
  });

  test('the range counts billing months from the newest statement', () => {
    const insights = buildInsights(input, '3', 'a')!;
    expect(insights.range).toEqual({ from: '2026-02', to: '2026-04' });
    expect(insights.statementCount).toBe(3);
    expect(insights.whereItWent.total).toBe(9000);
  });

  test('all cards together', () => {
    const insights = buildInsights(input, 'all')!;
    expect(insights.statementCount).toBe(5);
    expect(insights.whereItWent.total).toBe(10050);
  });

  test('an unknown card or an empty store has nothing to show', () => {
    expect(buildInsights(input, '3', 'nope')).toBeNull();
    expect(
      buildInsights(
        { cards: [], statements: [], transactions: [], cycles: [] },
        'all',
      ),
    ).toBeNull();
  });
});
