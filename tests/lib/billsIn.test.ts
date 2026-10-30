import { describe, expect, it } from 'vitest';
import {
  billsIn,
  billsInCopy,
  expectedNextStatementISO,
  usualStatementDay,
} from '../../src/lib/billsIn';
import { ordinal } from '../../src/lib/dates';
import type {
  CardRecord,
  CycleRecord,
  StatementRecord,
} from '../../src/db/schema';

const card = (id: string): CardRecord => ({
  id,
  last4: null,
  nickname: id,
  createdAt: '2025-01-01T00:00:00.000Z',
});

/** One statement per date, period from the date. */
const statements = (cardId: string, ...dates: string[]): StatementRecord[] =>
  dates.map((date) => ({
    id: `${cardId}-${date}`,
    cardId,
    period: date.slice(0, 7),
    statementDateISO: date,
    fileName: 'x.csv',
    txnCount: 1,
    importedAt: '2025-01-01T00:00:00.000Z',
  }));

const cycle = (
  cardId: string,
  period: string,
  dueDateISO: string,
  paid = false,
): CycleRecord => ({
  cardId,
  period,
  dueDateISO,
  source: 'statement',
  totalDue: 1000,
  ...(paid ? { paidAt: '2025-01-01' } : {}),
});

describe('usualStatementDay / expectedNextStatementISO', () => {
  it('takes the median of recent statement days, ignoring a one-off', () => {
    const s = statements('a', '2025-08-18', '2025-09-17', '2025-10-18');
    expect(usualStatementDay(s)).toBe(18);
    expect(expectedNextStatementISO(s)).toBe('2025-11-18');
  });

  it('never expects the next statement within days of the latest', () => {
    // Latest came a day early; the next is next month, not tomorrow.
    const s = statements('a', '2025-09-18', '2025-10-17');
    expect(usualStatementDay(s)).toBe(17);
    expect(
      expectedNextStatementISO([...s, ...statements('a', '2025-08-18')]),
    ).toBe('2025-11-18');
  });

  it('clamps to the month end', () => {
    expect(expectedNextStatementISO(statements('a', '2026-01-31'))).toBe(
      '2026-02-28',
    );
  });

  it('is unknown when no statement is dated', () => {
    const undated = statements('a', '2025-10-18').map((s) => {
      const copy = { ...s };
      delete copy.statementDateISO;
      return copy;
    });
    expect(usualStatementDay(undated)).toBeNull();
    expect(expectedNextStatementISO(undated)).toBeNull();
  });
});

describe("billsIn: counts the calendar month's bills", () => {
  // Five cards with statement days 3, 10, 15, 18 and 25; today 16 Nov.
  // A, B and C have November's bill in, unpaid; D and E were paid last
  // month and their November statements are still to come.
  const cards = ['A', 'B', 'C', 'D', 'E'].map(card);
  const all = [
    ...statements('A', '2025-10-03', '2025-11-03'),
    ...statements('B', '2025-10-10', '2025-11-10'),
    ...statements('C', '2025-10-15', '2025-11-15'),
    ...statements('D', '2025-09-18', '2025-10-18'),
    ...statements('E', '2025-09-25', '2025-10-25'),
  ];
  const cycles = [
    cycle('A', '2025-11', '2025-11-23'),
    cycle('B', '2025-11', '2025-11-30'),
    cycle('C', '2025-11', '2025-12-05'),
    cycle('D', '2025-10', '2025-11-07', true),
    cycle('E', '2025-10', '2025-11-14', true),
  ];
  // D and E's November bills arrive.
  const allIn = [
    ...all,
    ...statements('D', '2025-11-18'),
    ...statements('E', '2025-11-20'),
  ];
  const allInCycles = (paid: string[]) =>
    [
      cycle('A', '2025-11', '2025-11-23'),
      cycle('B', '2025-11', '2025-11-30'),
      cycle('C', '2025-11', '2025-12-05'),
      cycle('D', '2025-10', '2025-11-07', true),
      cycle('E', '2025-10', '2025-11-14', true),
      cycle('D', '2025-11', '2025-12-08'),
      cycle('E', '2025-11', '2025-12-15'),
    ].map((c) =>
      c.period === '2025-11' && paid.includes(c.cardId)
        ? { ...c, paidAt: '2025-11-21' }
        : c,
    );

  it('names the next bill expected and the next payment due, separately', () => {
    const result = billsIn(cards, all, cycles, '2025-11-16');
    expect(result).toMatchObject({
      month: '2025-11',
      cardCount: 5,
      inCount: 3,
      allInPaid: false,
      nextBillISO: '2025-11-18',
      earliestDueISO: '2025-11-23',
    });
    expect(result.awaited.map((a) => [a.card.id, a.expectedISO])).toEqual([
      ['D', '2025-11-18'],
      ['E', '2025-11-25'],
    ]);
    expect(billsInCopy(result, '2025-11-16')).toEqual({
      lead: '3 of 5 November bills are in',
      lines: [
        {
          prefix: 'Next bill expected around',
          dateISO: '2025-11-18',
          strong: false,
        },
        { prefix: 'Next payment due', dateISO: '2025-11-23', strong: true },
      ],
      notes: [],
    });
  });

  it('a bill due before the rest of the month arrives still shows its due date', () => {
    // A is due 23 Nov; E's bill only arrives around 25 Nov. Waiting for
    // "all in" must not hide A's deadline.
    const copy = billsInCopy(
      billsIn(cards, all, cycles, '2025-11-16'),
      '2025-11-16',
    );
    expect(copy.lines).toContainEqual({
      prefix: 'Next payment due',
      dateISO: '2025-11-23',
      strong: true,
    });
  });

  it("all in: the payment due is the news, not next month's bill", () => {
    const copy = billsInCopy(
      billsIn(cards, allIn, allInCycles([]), '2025-11-21'),
      '2025-11-21',
    );
    expect(copy).toEqual({
      lead: 'All 5 November bills are in',
      lines: [
        { prefix: 'Next payment due', dateISO: '2025-11-23', strong: true },
      ],
      notes: [],
    });
  });

  it('paying a bill never lowers the count (regression)', () => {
    // Paying A used to turn its next statement into one "to come", so
    // "all 5 in" dropped to "4 of 5" with a list of bills to pay now.
    const result = billsIn(cards, allIn, allInCycles(['A']), '2025-11-21');
    expect(result.inCount).toBe(5);
    expect(result.awaited).toEqual([]);
    expect(billsInCopy(result, '2025-11-21')).toEqual({
      lead: 'All 5 November bills are in',
      lines: [
        { prefix: 'Next payment due', dateISO: '2025-11-30', strong: true },
      ],
      notes: [],
    });
  });

  it('all paid: says so, and when the next bill is expected', () => {
    const result = billsIn(
      cards,
      allIn,
      allInCycles(['A', 'B', 'C', 'D', 'E']),
      '2025-11-22',
    );
    expect(result.earliestDueISO).toBeNull();
    expect(billsInCopy(result, '2025-11-22')).toEqual({
      lead: 'All 5 November bills are paid',
      lines: [
        {
          prefix: 'Next bill expected around',
          dateISO: '2025-12-03',
          strong: false,
        },
      ],
      notes: [],
    });
  });

  it('some in, each of those paid', () => {
    const paid = cycles.map((c) =>
      c.period === '2025-11' ? { ...c, paidAt: '2025-11-16' } : c,
    );
    expect(
      billsInCopy(billsIn(cards, all, paid, '2025-11-16'), '2025-11-16'),
    ).toEqual({
      lead: '3 of 5 November bills are in and paid',
      lines: [
        {
          prefix: 'Next bill expected around',
          dateISO: '2025-11-18',
          strong: false,
        },
      ],
      notes: [],
    });
  });

  it("a new month starts from zero; last month's unpaid bill keeps its due date", () => {
    // 2 Dec: no December statement yet; C's November bill is unpaid.
    const result = billsIn(
      cards,
      allIn,
      allInCycles(['A', 'B', 'D', 'E']),
      '2025-12-02',
    );
    expect(result).toMatchObject({ inCount: 0, cardCount: 5 });
    expect(billsInCopy(result, '2025-12-02')).toEqual({
      lead: '0 of 5 December bills are in',
      lines: [
        {
          prefix: 'Next bill expected around',
          dateISO: '2025-12-03',
          strong: false,
        },
        { prefix: 'Next payment due', dateISO: '2025-12-05', strong: true },
      ],
      notes: [],
    });
  });
});

describe('billsIn: which cards are counted', () => {
  it("doesn't count a card whose next statement falls in a later month", () => {
    // B's latest came on 31 Oct though it's usually the 1st: its next is
    // 1 Dec, so it has no November bill.
    const result = billsIn(
      [card('A'), card('B')],
      [
        ...statements('A', '2025-11-03'),
        ...statements('B', '2025-08-01', '2025-09-01', '2025-10-31'),
      ],
      [cycle('A', '2025-11', '2025-11-23')],
      '2025-11-16',
    );
    expect(result).toMatchObject({ cardCount: 1, inCount: 1 });
    expect(result.awaited).toEqual([]);
  });

  it('calls out a late statement, counted but not named as the next bill', () => {
    const result = billsIn(
      [card('Axis')],
      statements('Axis', '2025-09-18', '2025-10-18'),
      [cycle('Axis', '2025-10', '2025-11-07', true)],
      '2025-11-22',
    );
    expect(result.awaited).toMatchObject([{ late: true, usualDay: 18 }]);
    expect(result.nextBillISO).toBeNull();
    expect(billsInCopy(result, '2025-11-22')).toEqual({
      lead: null,
      lines: [],
      notes: ["Axis's bill usually comes by the 18th and isn't in yet."],
    });
  });

  it('a just-expected statement is not late yet', () => {
    const result = billsIn(
      [card('Axis')],
      statements('Axis', '2025-10-18'),
      [cycle('Axis', '2025-10', '2025-11-07', true)],
      '2025-11-20',
    );
    expect(result.awaited).toMatchObject([{ late: false }]);
  });

  it('stops counting a statement more than a cycle overdue (card likely dropped)', () => {
    const result = billsIn(
      [card('Axis')],
      statements('Axis', '2025-10-18'),
      [cycle('Axis', '2025-10', '2025-11-07', true)],
      '2026-01-05',
    );
    expect(result).toMatchObject({ cardCount: 0, awaited: [] });
  });

  it("an undated statement still counts as this month's bill", () => {
    const undatedOct = statements('B', '2026-10-18').map((s) => {
      const copy = { ...s };
      delete copy.statementDateISO;
      return copy;
    });
    const result = billsIn(
      [card('A'), card('B')],
      [
        ...statements('A', '2026-10-07'),
        ...statements('B', '2026-08-18', '2026-09-18'),
        ...undatedOct,
      ],
      [
        cycle('A', '2026-10', '2026-10-27'),
        cycle('B', '2026-10', '2026-11-07', true),
      ],
      '2026-10-26',
    );
    expect(result).toMatchObject({ cardCount: 2, inCount: 2, awaited: [] });
  });
});

describe('billsInCopy: payment due wording', () => {
  const one = (dueISO: string, todayISO: string) =>
    billsInCopy(
      billsIn(
        [card('A')],
        statements('A', '2025-10-03'),
        [cycle('A', '2025-10', dueISO)],
        todayISO,
      ),
      todayISO,
    );

  it('one card: no count; due today is still "next payment due"', () => {
    expect(one('2025-10-23', '2025-10-23')).toEqual({
      lead: null,
      lines: [
        { prefix: 'Next payment due', dateISO: '2025-10-23', strong: true },
      ],
      notes: [],
    });
  });

  it('past due says overdue', () => {
    expect(one('2025-10-23', '2025-10-30').lines).toEqual([
      { prefix: 'Payment overdue since', dateISO: '2025-10-23', strong: true },
    ]);
  });

  it('a stale due date never hides a payment due soon', () => {
    // A's August bill was never followed by a newer statement; B is due
    // 5 Nov. B's date is the one to headline.
    const result = billsIn(
      [card('A'), card('B')],
      [...statements('A', '2025-07-25'), ...statements('B', '2025-10-16')],
      [
        cycle('A', '2025-07', '2025-08-15'),
        cycle('B', '2025-10', '2025-11-05'),
      ],
      '2025-10-30',
    );
    expect(result.earliestDueISO).toBe('2025-11-05');
    expect(billsInCopy(result, '2025-10-30').lines.at(-1)?.prefix).toBe(
      'Next payment due',
    );
  });

  it('an unpaid bill with no due date is named, not left out', () => {
    const result = billsIn(
      [card('A'), card('B')],
      [...statements('A', '2025-10-03'), ...statements('B', '2025-10-16')],
      [
        { ...cycle('A', '2025-10', ''), dueDateISO: null },
        cycle('B', '2025-10', '2025-11-05'),
      ],
      '2025-10-30',
    );
    expect(result.earliestDueISO).toBe('2025-11-05');
    expect(billsInCopy(result, '2025-10-30').notes).toEqual([
      "A's due date isn't known. Check its statement.",
    ]);
  });

  it("'paid' follows the bill owed now, not an older one of the month", () => {
    // B's October bill is paid but a newer, unpaid statement is in.
    const result = billsIn(
      [card('A'), card('B')],
      [
        ...statements('A', '2025-10-03'),
        ...statements('B', '2025-10-05', '2025-11-04'),
      ],
      [
        cycle('A', '2025-10', '2025-10-23', true),
        cycle('B', '2025-10', '2025-10-25', true),
        cycle('B', '2025-11', '2025-11-24'),
      ],
      '2025-10-30',
    );
    expect(result.allInPaid).toBe(false);
  });

  it('long past due reads as stale data, not a fresh alarm', () => {
    expect(one('2025-10-23', '2025-11-30').lines.at(-1)?.prefix).toBe(
      'A payment was due',
    );
  });
});

describe('ordinal', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [31, '31st'],
  ])('%i → %s', (day, text) => {
    expect(ordinal(day)).toBe(text);
  });
});
