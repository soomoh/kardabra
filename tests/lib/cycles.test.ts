import { describe, it, expect } from 'vitest';
import {
  actionableCycle,
  isSettledBySuccessor,
  cycleNeedsPayment,
} from '../../src/lib/cycles';
import { unpaidSummary } from '../../src/lib/unpaidSummary';
import { formatINR } from '../../src/lib/money';
import type { CardRecord, CycleRecord } from '../../src/db/schema';

function cycle(overrides: Partial<CycleRecord> = {}): CycleRecord {
  return {
    cardId: 'card-1',
    period: '2025-10',
    dueDateISO: '2025-11-09',
    source: 'statement',
    ...overrides,
  };
}

describe('actionableCycle — the settled-by-successor rule', () => {
  it('returns null for a card with no cycles', () => {
    expect(actionableCycle([])).toBeNull();
  });

  it('picks the latest period regardless of input order', () => {
    const cycles = [
      cycle({ period: '2025-10', totalDue: 7162 }),
      cycle({ period: '2025-08', totalDue: 4000 }),
      cycle({ period: '2025-09', totalDue: 5000 }),
    ];
    expect(actionableCycle(cycles)?.period).toBe('2025-10');
    expect(actionableCycle(cycles)?.totalDue).toBe(7162);
  });

  it('year boundary: 2026-01 supersedes 2025-12 (lexicographic = chronological)', () => {
    const cycles = [cycle({ period: '2025-12' }), cycle({ period: '2026-01' })];
    expect(actionableCycle(cycles)?.period).toBe('2026-01');
  });
});

describe('isSettledBySuccessor', () => {
  const cycles = [
    cycle({ period: '2025-08' }),
    cycle({ period: '2025-09' }),
    cycle({ period: '2025-10' }),
  ];

  it('older periods are settled, the latest is not', () => {
    expect(isSettledBySuccessor('2025-08', cycles)).toBe(true);
    expect(isSettledBySuccessor('2025-09', cycles)).toBe(true);
    expect(isSettledBySuccessor('2025-10', cycles)).toBe(false);
  });

  it('a lone cycle is never settled', () => {
    expect(isSettledBySuccessor('2025-10', [cycle()])).toBe(false);
  });
});

describe('cycleNeedsPayment', () => {
  it('a normal unpaid bill needs payment', () => {
    expect(cycleNeedsPayment({ totalDue: 7162 })).toBe(true);
  });

  it('user-paid never needs payment', () => {
    expect(cycleNeedsPayment({ totalDue: 7162, paidAt: '2025-11-10' })).toBe(
      false,
    );
  });

  it('regression (real incident): a KNOWN-zero bill needs no payment — 0 is a value, not a missing value', () => {
    // A card with no transactions in the period showed "Overdue" over a
    // ₹0 balance. totalDue === 0 (the bank's own figure) must read as
    // "nothing due", even with a printed due date in the past.
    expect(cycleNeedsPayment({ totalDue: 0 })).toBe(false);
    expect(cycleNeedsPayment({ totalDue: 0, spend: 500 })).toBe(false); // trust the bank's total
  });

  it('no bill figure + zero spend needs no payment (no-summary banks)', () => {
    expect(cycleNeedsPayment({ spend: 0 })).toBe(false);
  });

  it('no bill figure but real spend still needs payment', () => {
    expect(cycleNeedsPayment({ spend: 26120.93 })).toBe(true);
  });

  it('nothing known at all: assume payment needed (fail toward reminding)', () => {
    expect(cycleNeedsPayment({})).toBe(true);
  });
});

describe('unpaidSummary counts only actionable cycles', () => {
  // Regression: with multiple historical statements imported for one
  // card, the dashboard total must reflect
  // only the latest statement's due — the bank's own total already
  // includes any carry-forward (see lib/cycles.ts). The dashboard feeds
  // this function one actionable cycle per card, so a card with three
  // months of history contributes exactly one number, never a sum of
  // three overlapping ones.
  const card: CardRecord = {
    id: 'card-1',
    last4: '2836',
    nickname: 'Regalia',
    createdAt: '2025-11-01T00:00:00.000Z',
  };

  it('one card with history: only the actionable total appears', () => {
    const history = [
      cycle({ period: '2025-08', totalDue: 4000 }),
      cycle({ period: '2025-09', totalDue: 5000 }),
      cycle({ period: '2025-10', totalDue: 7162 }),
    ];
    const entries = [{ card, cycle: actionableCycle(history) }];
    // Expected string built via formatINR rather than hardcoded — the ICU
    // currency formatter's exact space characters vary (see money.test.ts).
    expect(unpaidSummary(entries)).toBe(`1 unpaid · ${formatINR(7162)} due`);
  });

  it('regression (user request): spend stands in for a missing totalDue, marked as an estimate', () => {
    // A no-summary bank's card must not blank the birds-eye total — its
    // computed spend substitutes, and the '~' says the sum is approximate.
    const entries = [
      { card, cycle: cycle({ totalDue: undefined, spend: 26120.93 }) },
      {
        card: { ...card, id: 'card-2' },
        cycle: cycle({ cardId: 'card-2', totalDue: 500 }),
      },
    ];
    expect(unpaidSummary(entries)).toBe(
      `2 unpaid · ~${formatINR(26620.93)} due`,
    );
  });

  it('all-bank-stated totals carry no estimate marker', () => {
    const entries = [
      { card, cycle: cycle({ totalDue: 7162 }) },
      {
        card: { ...card, id: 'card-2' },
        cycle: cycle({ cardId: 'card-2', totalDue: 500 }),
      },
    ];
    expect(unpaidSummary(entries)).toBe(`2 unpaid · ${formatINR(7662)} due`);
  });

  it('a cycle with neither totalDue nor spend still suppresses the sum (never a partial total)', () => {
    const entries = [
      { card, cycle: cycle({ totalDue: undefined, spend: undefined }) },
      {
        card: { ...card, id: 'card-2' },
        cycle: cycle({ cardId: 'card-2', totalDue: 500 }),
      },
    ];
    expect(unpaidSummary(entries)).toBe('2 unpaid');
  });
});
