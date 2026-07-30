import { describe, it, expect } from 'vitest';
import {
  sortDashboardCards,
  type CardWithCycle,
} from '../../src/lib/sortCards';
import type { CardRecord, CycleRecord } from '../../src/db/schema';

function card(id: string, nickname: string): CardRecord {
  return { id, last4: null, nickname, createdAt: '2025-11-01T00:00:00.000Z' };
}

function cycle(overrides: Partial<CycleRecord> = {}): CycleRecord {
  return {
    cardId: 'x',
    period: '2025-11',
    dueDateISO: null,
    source: 'statement',
    ...overrides,
  };
}

describe('sortDashboardCards', () => {
  it('orders unpaid-known-due (earliest first), then unpaid-unknown-due, then paid, then no-cycle', () => {
    const noCycle: CardWithCycle = { card: card('a', 'No cycle'), cycle: null };
    const paid: CardWithCycle = {
      card: card('b', 'Paid'),
      cycle: cycle({
        cardId: 'b',
        dueDateISO: '2025-11-05',
        paidAt: '2025-11-01T00:00:00.000Z',
      }),
    };
    const unknownDue: CardWithCycle = {
      card: card('c', 'Unknown due'),
      cycle: cycle({ cardId: 'c', dueDateISO: null }),
    };
    const dueLater: CardWithCycle = {
      card: card('d', 'Due later'),
      cycle: cycle({ cardId: 'd', dueDateISO: '2025-11-20' }),
    };
    const dueSoonest: CardWithCycle = {
      card: card('e', 'Due soonest'),
      cycle: cycle({ cardId: 'e', dueDateISO: '2025-11-12' }),
    };

    // Deliberately scrambled input order — the sort, not the input, must
    // produce the expected order.
    const result = sortDashboardCards([
      noCycle,
      paid,
      dueLater,
      unknownDue,
      dueSoonest,
    ]);

    expect(result.map((e) => e.card.nickname)).toEqual([
      'Due soonest',
      'Due later',
      'Unknown due',
      'Paid',
      'No cycle',
    ]);
  });

  it('zero-due and no-spend cycles rank with the calm (paid) group, not as urgent unpaid', () => {
    const zeroDue: CardWithCycle = {
      card: card('z', 'Zero due'),
      // Past due date + totalDue 0: needs no payment, so it must NOT
      // outrank a genuinely-owed card (the Ultima Supreme regression).
      cycle: cycle({ cardId: 'z', dueDateISO: '2025-10-01', totalDue: 0 }),
    };
    const owed: CardWithCycle = {
      card: card('o', 'Owed'),
      cycle: cycle({ cardId: 'o', dueDateISO: '2025-11-20', totalDue: 5000 }),
    };
    const sorted = sortDashboardCards([zeroDue, owed]);
    expect(sorted.map((e) => e.card.id)).toEqual(['o', 'z']);
  });

  it('keeps input order for ties within a group (stable sort)', () => {
    const first: CardWithCycle = {
      card: card('a', 'First unknown'),
      cycle: cycle({ cardId: 'a', dueDateISO: null }),
    };
    const second: CardWithCycle = {
      card: card('b', 'Second unknown'),
      cycle: cycle({ cardId: 'b', dueDateISO: null }),
    };

    const result = sortDashboardCards([second, first]);
    expect(result.map((e) => e.card.nickname)).toEqual([
      'Second unknown',
      'First unknown',
    ]);
  });

  it('an empty list sorts to an empty list', () => {
    expect(sortDashboardCards([])).toEqual([]);
  });
});
