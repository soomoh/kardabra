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

describe('billsIn', () => {
  // Five cards with statement days 3, 10, 15, 18 and 25; today 16 Nov.
  // A, B and C have this month's bill in, unpaid; D and E were paid last
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

  it('names what is still to come, and the bill that cannot wait for it', () => {
    const result = billsIn(cards, all, cycles, '2025-11-16');
    expect(result.inCount).toBe(3);
    expect(result.awaited.map((a) => [a.card.id, a.expectedISO])).toEqual([
      ['D', '2025-11-18'],
      ['E', '2025-11-25'],
    ]);
    // A is due 23 Nov, before E (25 Nov) arrives: waiting would make it late.
    expect(result.payNow.map((p) => [p.card.id, p.dueISO])).toEqual([
      ['A', '2025-11-23'],
    ]);
    expect(result.earliestDueISO).toBe('2025-11-23');

    expect(billsInCopy(result, '2025-11-16')).toEqual({
      lead: '3 of 5 bills are in',
      duePrefix: 'First due',
      dueISO: '2025-11-23',
      notes: [
        'Still to come: D around 18 Nov, E around 25 Nov.',
        "Pay A now: it's due 23 Nov, before the rest arrive.",
      ],
    });
  });

  it('all in once every awaited statement has arrived', () => {
    const later = [
      ...all,
      ...statements('D', '2025-11-18'),
      ...statements('E', '2025-11-20'), // came early
    ];
    const result = billsIn(
      cards,
      later,
      [
        ...cycles,
        cycle('D', '2025-11', '2025-12-08'),
        cycle('E', '2025-11', '2025-12-15'),
      ],
      '2025-11-21',
    );
    expect(result.inCount).toBe(5);
    expect(result.awaited).toEqual([]);
    expect(result.payNow).toEqual([]);
    expect(billsInCopy(result, '2025-11-21')).toMatchObject({
      lead: 'All 5 bills are in',
      duePrefix: 'Pay before',
      dueISO: '2025-11-23',
    });
  });

  it("doesn't wait for a card whose next statement comes after every bill is due", () => {
    // Only A unpaid (due 23 Nov); B's next statement (10 Dec) is next batch.
    const result = billsIn(
      [card('A'), card('B')],
      [...statements('A', '2025-11-03'), ...statements('B', '2025-11-10')],
      [
        cycle('A', '2025-11', '2025-11-23'),
        cycle('B', '2025-11', '2025-11-30', true),
      ],
      '2025-11-16',
    );
    expect(result.awaited).toEqual([]);
    expect(result.inCount).toBe(2);
    expect(result.payNow).toEqual([]);
  });

  it('calls out a late statement even with nothing to pay, without a pay-now', () => {
    const result = billsIn(
      [card('Axis')],
      statements('Axis', '2025-09-18', '2025-10-18'),
      [cycle('Axis', '2025-10', '2025-11-07', true)],
      '2025-11-22',
    );
    expect(result.awaited).toMatchObject([{ late: true, usualDay: 18 }]);
    expect(result.payNow).toEqual([]);
    expect(billsInCopy(result, '2025-11-22').notes).toEqual([
      "Axis's statement usually comes by the 18th and isn't in yet.",
    ]);
  });

  it('stops naming a statement more than a cycle overdue (card likely dropped)', () => {
    const result = billsIn(
      [card('Axis')],
      statements('Axis', '2025-10-18'),
      [cycle('Axis', '2025-10', '2025-11-07', true)],
      '2026-01-05',
    );
    expect(result.awaited).toEqual([]);
  });

  it('a just-expected statement is not late yet', () => {
    const result = billsIn(
      [card('Axis')],
      statements('Axis', '2025-10-18'),
      [cycle('Axis', '2025-10', '2025-11-07', true)],
      '2025-11-20',
    );
    expect(result.awaited).toEqual([]);
  });

  it('one card: no count, and an overdue bill says so', () => {
    const result = billsIn(
      [card('A')],
      statements('A', '2025-10-03'),
      [cycle('A', '2025-10', '2025-10-23')],
      '2025-10-30',
    );
    expect(billsInCopy(result, '2025-10-30')).toEqual({
      lead: null,
      duePrefix: 'One was due',
      dueISO: '2025-10-23',
      notes: [],
    });
  });
});

describe('billsIn: waiting never makes a bill overdue', () => {
  const two = [card('A'), card('B')];
  const bPaid = cycle('B', '2026-10', '2026-10-25', true);

  it('flags a bill due within the days a statement may run late', () => {
    // B expected 5 Nov but may come up to 8 Nov; A due 6 Nov can't wait.
    const result = billsIn(
      two,
      [
        ...statements('A', '2026-10-15'),
        ...statements('B', '2026-09-05', '2026-10-05'),
      ],
      [cycle('A', '2026-10', '2026-11-06'), bPaid],
      '2026-11-01',
    );
    expect(result.awaited.map((a) => a.card.id)).toEqual(['B']);
    expect(result.payNow.map((p) => p.card.id)).toEqual(['A']);
    expect(billsInCopy(result, '2026-11-01').notes.at(-1)).toBe(
      "Pay A now: it's due 6 Nov, before B's statement arrives.",
    );
  });

  it('while a statement is late, flags bills due in the next few days', () => {
    const result = billsIn(
      two,
      [
        ...statements('A', '2026-10-07'),
        ...statements('B', '2026-08-18', '2026-09-18'),
      ],
      [
        cycle('A', '2026-10', '2026-10-27'),
        cycle('B', '2026-09', '2026-10-08', true),
      ],
      '2026-10-26',
    );
    expect(result.awaited).toMatchObject([{ late: true }]);
    expect(result.payNow.map((p) => p.dueISO)).toEqual(['2026-10-27']);
  });

  it("doesn't call a statement missing when the newest one is in but undated", () => {
    const undatedOct = statements('B', '2026-10-18').map((s) => {
      const copy = { ...s };
      delete copy.statementDateISO;
      return copy;
    });
    const result = billsIn(
      two,
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
    expect(result.awaited).toEqual([]);
    expect(result.payNow).toEqual([]);
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
