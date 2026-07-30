import { describe, it, expect } from 'vitest';
import {
  monthlyTrends,
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

describe('allocateSegmentHeights — no nonzero segment may vanish', () => {
  // Bar of 100px, min 4px, gap 2px throughout unless a case says otherwise.
  const BAR = 100;
  const MIN = 4;
  const GAP = 2;

  it('proportional when everything already clears the minimum', () => {
    const heights = allocateSegmentHeights([300, 100], BAR, MIN, GAP);
    // available = 100 - 2 = 98; proportions 3:1 -> 73.5 / 24.5
    expect(heights[0]).toBeCloseTo(73.5, 5);
    expect(heights[1]).toBeCloseTo(24.5, 5);
    // Total height stays truthful: segments + one gap = the bar height.
    expect(heights[0] + heights[1] + GAP).toBeCloseTo(BAR, 5);
  });

  it('gives a tiny nonzero value the min bar height instead of letting it vanish', () => {
    // 1-vs-999 split: proportionally the small segment would get
    // ~0.098px — under the old gap subtraction it rendered as nothing.
    const heights = allocateSegmentHeights([1, 999], BAR, MIN, GAP);
    expect(heights[0]).toBe(MIN);
    // ...and the largest absorbed exactly the difference, so the bar's
    // total height is still truthful to the month total.
    expect(heights[0] + heights[1] + GAP).toBeCloseTo(BAR, 5);
  });

  it('the LARGEST segment absorbs the boost, not a middle one', () => {
    const heights = allocateSegmentHeights([1, 500, 1000], BAR, MIN, GAP);
    // available = 100 - 2*2 = 96. Proportional: ~0.064 / 31.98 / 63.96.
    // Both tiny-segment boosts must come out of the 1000 segment only —
    // the 500 segment keeps its proportional height untouched.
    expect(heights[0]).toBe(MIN);
    expect(heights[1]).toBeCloseTo((500 / 1501) * 96, 5);
    const total = heights[0] + heights[1] + heights[2] + 2 * GAP;
    expect(total).toBeCloseTo(BAR, 5);
  });

  it('zero values get exactly zero — no phantom slivers, no gap charged for them', () => {
    const heights = allocateSegmentHeights([0, 300, 0, 100], BAR, MIN, GAP);
    expect(heights[0]).toBe(0);
    expect(heights[2]).toBe(0);
    // Only ONE gap (between the two nonzero segments), so segments sum
    // to bar height minus one gap, not three.
    expect(heights[1] + heights[3] + GAP).toBeCloseTo(BAR, 5);
  });

  it('all-zero input: all-zero output', () => {
    expect(allocateSegmentHeights([0, 0, 0], BAR, MIN, GAP)).toEqual([0, 0, 0]);
  });

  it('degenerate: mins exceed the bar height -> equal split of what fits, nothing vanishes', () => {
    // 4 nonzero segments, min 4px each + 3 gaps = 22px needed, but the
    // bar is only 10px tall. Proportionality is abandoned: every
    // segment gets an equal (tiny) share, none disappears.
    const heights = allocateSegmentHeights([1, 2, 3, 4], 10, MIN, GAP);
    const each = (10 - 3 * GAP) / 4;
    for (const height of heights) {
      expect(height).toBeCloseTo(each, 5);
      expect(height).toBeGreaterThan(0);
    }
  });

  it('single segment: gets the whole bar, no gap involved', () => {
    expect(allocateSegmentHeights([42], BAR, MIN, GAP)).toEqual([BAR]);
  });
});
