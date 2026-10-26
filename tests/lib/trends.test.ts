import { describe, it, expect } from 'vitest';
import {
  monthlyTrends,
  cycleKey,
  visibleMonthTotals,
  allocateSegmentHeights,
  type TrendsCard,
  type TrendsCycle,
} from '../../src/lib/trends';

function card(id: string, createdAt: string, nickname = id): TrendsCard {
  return { id, createdAt, nickname };
}

describe('monthlyTrends — empty input', () => {
  it('no cycles at all: nothing to trend', () => {
    expect(monthlyTrends([], [])).toEqual({
      periods: [],
      series: [],
      monthTotals: [],
    });
  });
});

describe('monthlyTrends — reads cycle.spend directly, trailing 6 months, gap months zero-filled', () => {
  const cards = [card('card-1', '2025-01-01T00:00:00.000Z', 'Regalia')];
  // Only two of the six trailing months (ending 2026-01, the latest
  // cycle's period) actually have a cycle — every other month must still
  // appear in `periods` with a zero value, not be omitted.
  const cycles: TrendsCycle[] = [
    { cardId: 'card-1', period: '2025-10', spend: 500 },
    { cardId: 'card-1', period: '2026-01', spend: 1500 },
  ];

  const result = monthlyTrends(cards, cycles);

  it('periods run 6 consecutive months ending at the latest cycle period', () => {
    expect(result.periods).toEqual([
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
    ]);
  });

  it('months with no cycle are zero, months with one show its stored spend', () => {
    const series = result.series[0];
    expect(series.values[result.periods.indexOf('2025-09')]).toBe(0);
    expect(series.values[result.periods.indexOf('2025-10')]).toBe(500);
    expect(series.values[result.periods.indexOf('2026-01')]).toBe(1500);
  });

  it('a cycle with spend undefined (never computed) reads as zero, not "unknown"', () => {
    const withPredicted = monthlyTrends(cards, [
      ...cycles,
      { cardId: 'card-1', period: '2025-12' }, // no spend field at all
    ]);
    expect(
      withPredicted.series[0].values[withPredicted.periods.indexOf('2025-12')],
    ).toBe(0);
  });

  it('a cycle outside the trailing-6 window is excluded, not wrapped in', () => {
    const withOldCycle = monthlyTrends(cards, [
      ...cycles,
      { cardId: 'card-1', period: '2025-07', spend: 9999 },
    ]);
    // periods still start at 2025-08 — 2025-07 never appears, and its
    // spend never leaks into any total.
    expect(withOldCycle.periods).not.toContain('2025-07');
    expect(withOldCycle.monthTotals.reduce((a, b) => a + b, 0)).toBe(2000);
  });

  it('month totals sum every series for that period', () => {
    expect(result.monthTotals[result.periods.indexOf('2025-10')]).toBe(500);
    expect(result.monthTotals[result.periods.indexOf('2026-01')]).toBe(1500);
  });
});

describe('monthlyTrends — series ordering and the >8-card fold', () => {
  it('series are ordered by card createdAt, not input order', () => {
    const cards = [
      card('newer', '2025-06-01T00:00:00.000Z'),
      card('older', '2025-01-01T00:00:00.000Z'),
    ];
    const cycles: TrendsCycle[] = [
      { cardId: 'newer', period: '2026-01', spend: 100 },
    ];
    const result = monthlyTrends(cards, cycles);
    expect(result.series.map((s) => s.cardId)).toEqual(['older', 'newer']);
  });

  it('a 9th card folds into a single "Other" series colored outside the named palette', () => {
    const cards = Array.from({ length: 9 }, (_, i) =>
      card(
        `card-${i}`,
        `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      ),
    );
    const cycles: TrendsCycle[] = cards.map((c, i) => ({
      cardId: c.id,
      period: '2026-01',
      spend: 100 * (i + 1), // card-8 (the 9th, index 8) spends 900
    }));

    const result = monthlyTrends(cards, cycles);

    expect(result.series).toHaveLength(9); // 8 named + 1 folded 'Other'
    const namedIds = result.series.slice(0, 8).map((s) => s.cardId);
    expect(namedIds).toEqual([
      'card-0',
      'card-1',
      'card-2',
      'card-3',
      'card-4',
      'card-5',
      'card-6',
      'card-7',
    ]);
    const other = result.series[8];
    expect(other.cardId).toBeNull();
    expect(other.nickname).toBe('Other');
    // only card-8 (the 9th card, index 8) is left to fold: 100*(8+1) = 900.
    // All cycles are period '2026-01' — the *latest*, not periods[0]
    // (periods runs oldest-to-newest, see the "trailing 6 months" test).
    const janIndex = result.periods.indexOf('2026-01');
    expect(other.values[janIndex]).toBe(900);
  });
});

describe('visibleMonthTotals — legend toggle arithmetic', () => {
  const series = [
    { cardId: 'a', nickname: 'A', values: [100, 200] },
    { cardId: 'b', nickname: 'B', values: [50, 60] },
    { cardId: null, nickname: 'Other', values: [10, 10] },
  ];

  it('with nothing excluded, equals the sum of every series', () => {
    expect(visibleMonthTotals(series, new Set())).toEqual([160, 270]);
  });

  it('excluding a card removes only its own contribution', () => {
    expect(visibleMonthTotals(series, new Set(['a']))).toEqual([60, 70]);
  });

  it('the folded Other bucket (cardId null) can never be excluded by a cardId', () => {
    // Other has no cardId, so it can never appear in excludedCardIds —
    // it always stays visible via toggling individual cards.
    expect(visibleMonthTotals(series, new Set(['a', 'b']))).toEqual([10, 10]);
  });

  it('excluding every series returns all-zero totals, not an empty array', () => {
    const onlyCard = [{ cardId: 'a', nickname: 'A', values: [100, 200] }];
    expect(visibleMonthTotals(onlyCard, new Set(['a']))).toEqual([0, 0]);
  });
});

describe('monthlyTrends — unpaid months', () => {
  const cards = [
    { id: 'a', nickname: 'A', createdAt: '2025-01-01T00:00:00Z' },
    { id: 'b', nickname: 'B', createdAt: '2025-02-01T00:00:00Z' },
  ];
  const cycles = [
    { cardId: 'a', period: '2025-09', spend: 100 },
    { cardId: 'a', period: '2025-10', spend: 200 },
    { cardId: 'b', period: '2025-10', spend: 50 },
  ];

  it('flags exactly the (card, month) pairs passed as unpaid', () => {
    const result = monthlyTrends(
      cards,
      cycles,
      new Set([cycleKey('a', '2025-10')]),
    );
    const oct = result.periods.indexOf('2025-10');
    const sep = result.periods.indexOf('2025-09');
    expect(result.series[0].unpaid[oct]).toBe(true);
    expect(result.series[0].unpaid[sep]).toBe(false);
    expect(result.series[1].unpaid[oct]).toBe(false);
  });

  it('nothing is unpaid by default', () => {
    const result = monthlyTrends(cards, cycles);
    expect(result.series.flatMap((s) => s.unpaid).some(Boolean)).toBe(false);
  });
});

describe('allocateSegmentHeights — sizes stay honest', () => {
  const sum = (r: { heights: number[]; gap: number }) =>
    r.heights.reduce((a, b) => a + b, 0) +
    r.gap * (r.heights.filter((h) => h > 0).length - 1);

  it('proportional when everything already clears the minimum', () => {
    const r = allocateSegmentHeights([300, 100], 100, 2, 2);
    // available = 100 - 2 = 98; 3:1 -> 73.5 / 24.5
    expect(r.heights[0]).toBeCloseTo(73.5, 5);
    expect(r.heights[1]).toBeCloseTo(24.5, 5);
    expect(sum(r)).toBeCloseTo(100, 5);
  });

  it('₹3,000 vs ₹500 in a short bar stays about 6:1, never equal', () => {
    // The case that read as two equal blocks: a ~15px bar, the small
    // one unpaid (min 4) — before, the minimums forced an equal split.
    const r = allocateSegmentHeights([3000, 500], 15, [2, 4], 3);
    expect(r.gap).toBeCloseTo(15 * 0.15, 5); // gap shrinks on a short bar
    expect(r.heights[0] / r.heights[1]).toBeGreaterThan(2);
    expect(r.heights[0]).toBeGreaterThan(r.heights[1]);
    expect(sum(r)).toBeCloseTo(15, 5);
  });

  it('raises a tiny value to its minimum so it stays visible', () => {
    const r = allocateSegmentHeights([1, 999], 100, 2, 2);
    expect(r.heights[0]).toBe(2);
    expect(sum(r)).toBeCloseTo(100, 5);
  });

  it('the LARGEST segment pays for the raise, not a middle one', () => {
    const r = allocateSegmentHeights([1, 500, 1000], 100, 4, 2);
    expect(r.heights[0]).toBe(4);
    expect(r.heights[1]).toBeCloseTo((500 / 1501) * 96, 5);
    expect(sum(r)).toBeCloseTo(100, 5);
  });

  it('never draws a smaller value as tall as a bigger one: falls back to proportional', () => {
    // Raising 90 to its 60px minimum would push 100 down to 40px.
    const r = allocateSegmentHeights([100, 90], 100, [2, 60], 0);
    expect(r.heights[0]).toBeGreaterThan(r.heights[1]);
    expect(r.heights[0] / r.heights[1]).toBeCloseTo(100 / 90, 5);
  });

  it('proportional, not equal, when the minimums do not fit', () => {
    const r = allocateSegmentHeights([1, 2, 3, 4], 10, 4, 2);
    expect(r.heights[3] / r.heights[0]).toBeCloseTo(4, 5);
    expect(sum(r)).toBeCloseTo(10, 5);
  });

  it('zeros get exactly zero and no gap', () => {
    const r = allocateSegmentHeights([0, 300, 0, 100], 100, 2, 2);
    expect(r.heights[0]).toBe(0);
    expect(r.heights[2]).toBe(0);
    expect(r.heights[1] + r.heights[3] + r.gap).toBeCloseTo(100, 5);
  });

  it('all-zero input: all-zero output', () => {
    expect(allocateSegmentHeights([0, 0, 0], 100, 2, 2).heights).toEqual([
      0, 0, 0,
    ]);
  });

  it('single segment: the whole bar', () => {
    expect(allocateSegmentHeights([42], 100, 2, 2).heights).toEqual([100]);
  });
});

describe('monthlyTrends — missing statements', () => {
  it('marks a month between a card’s first and last statement as missing, not zero', () => {
    const trends = monthlyTrends(
      [{ id: 'a', nickname: 'A', createdAt: '2025-01-01T00:00:00Z' }],
      [
        { cardId: 'a', period: '2025-07', spend: 3000 },
        { cardId: 'a', period: '2025-09', spend: 500 },
      ],
    );
    const a = trends.series[0];
    const at = (period: string) => trends.periods.indexOf(period);
    expect(a.missing[at('2025-08')]).toBe(true);
    expect(a.values[at('2025-08')]).toBe(0);
    // Before the first statement there was nothing to miss.
    expect(a.missing[at('2025-06')]).toBe(false);
    expect(a.missing[at('2025-07')]).toBe(false);
    expect(a.missing[at('2025-09')]).toBe(false);
  });
});
