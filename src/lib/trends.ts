/**
 * The spend-trends chart's data, as plain functions testable without a DOM.
 * Each month's value is the stored cycle.spend, never re-derived here
 * (schema.ts CycleRecord.spend), so the chart agrees with every other view.
 */

// 6, not 12: the latest months must fit a 375px phone without scrolling.
const TRAILING_MONTHS = 6;
const MAX_NAMED_SERIES = 8;

export interface TrendsCard {
  id: string;
  nickname: string;
  createdAt: string; // ISO date-time — the stable ordering key, see below
}

/** The slice of CycleRecord this module needs. */
export interface TrendsCycle {
  cardId: string;
  period: string; // 'YYYY-MM'
  /** Missing for a cycle never computed; charted as 0. */
  spend?: number;
}

/** One series' values, aligned with MonthlyTrends.periods. `cardId: null`
 * is the folded 'Other' bucket (9th card onward). */
export interface TrendSeries {
  cardId: string | null;
  nickname: string;
  values: number[];
  /** Per period: the bill for that month is still unpaid (drawn hatched). */
  unpaid: boolean[];
}

export interface MonthlyTrends {
  /** The trailing TRAILING_MONTHS periods ending at the latest cycle,
   * oldest first; empty when there are no cycles. */
  periods: string[];
  /** Oldest card first, then 'Other'. Colours follow this order, so a
   * card keeps its colour however spend ranks shift — toggling one card off
   * never repaints the others. */
  series: TrendSeries[];
  /** Sum across every series (including Other), one per period. */
  monthTotals: number[];
}

/** The TRAILING_MONTHS periods ending at `latestPeriod`, oldest first. */
function trailingPeriods(latestPeriod: string): string[] {
  const [yearStr, monthStr] = latestPeriod.split('-');
  let year = Number(yearStr);
  let month = Number(monthStr); // 1-indexed calendar month
  const periods: string[] = [];
  for (let i = 0; i < TRAILING_MONTHS; i++) {
    periods.unshift(
      `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    );
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return periods;
}

/** A (card, period) map key; neither part can contain a space. */
export function cycleKey(cardId: string, period: string): string {
  return `${cardId} ${period}`;
}

/** Per-card spend for the trailing months, from every card's cycles. */
export function monthlyTrends(
  cards: TrendsCard[],
  cycles: TrendsCycle[],
  /** cycleKey()s of the bills still unpaid. */
  unpaidKeys: ReadonlySet<string> = new Set(),
): MonthlyTrends {
  if (cycles.length === 0) {
    return { periods: [], series: [], monthTotals: [] };
  }

  const latestPeriod = cycles.reduce(
    (max, cycle) => (cycle.period > max ? cycle.period : max),
    cycles[0].period,
  );
  const periods = trailingPeriods(latestPeriod);
  const periodSet = new Set(periods);

  const spendByKey = new Map<string, number>();
  for (const cycle of cycles) {
    if (!periodSet.has(cycle.period)) continue;
    spendByKey.set(cycleKey(cycle.cardId, cycle.period), cycle.spend ?? 0);
  }

  const orderedCards = [...cards].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const namedCards = orderedCards.slice(0, MAX_NAMED_SERIES);
  const foldedCards = orderedCards.slice(MAX_NAMED_SERIES);

  function valuesFor(cardId: string): number[] {
    // No cycle that month means nothing was billed: a real zero.
    return periods.map(
      (period) => spendByKey.get(cycleKey(cardId, period)) ?? 0,
    );
  }

  function unpaidFor(cardIds: string[]): boolean[] {
    return periods.map((period) =>
      cardIds.some((id) => unpaidKeys.has(cycleKey(id, period))),
    );
  }

  const series: TrendSeries[] = namedCards.map((card) => ({
    cardId: card.id,
    nickname: card.nickname,
    values: valuesFor(card.id),
    unpaid: unpaidFor([card.id]),
  }));

  if (foldedCards.length > 0) {
    const foldedValues = periods.map((_, periodIndex) =>
      foldedCards.reduce(
        (sum, card) => sum + (valuesFor(card.id)[periodIndex] ?? 0),
        0,
      ),
    );
    series.push({
      cardId: null,
      nickname: 'Other',
      values: foldedValues,
      unpaid: unpaidFor(foldedCards.map((card) => card.id)),
    });
  }

  const monthTotals = periods.map((_, periodIndex) =>
    series.reduce((sum, s) => sum + s.values[periodIndex], 0),
  );

  return { periods, series, monthTotals };
}

/** Month totals over the series still shown after the legend toggles some
 * cards off. Other cards' values and colours never change. */
export function visibleMonthTotals(
  series: Pick<TrendSeries, 'cardId' | 'values'>[],
  excludedCardIds: ReadonlySet<string>,
): number[] {
  const visible = series.filter(
    (s) => s.cardId === null || !excludedCardIds.has(s.cardId),
  );
  if (visible.length === 0) return series[0]?.values.map(() => 0) ?? [];
  return visible[0].values.map((_, periodIndex) =>
    visible.reduce((sum, s) => sum + s.values[periodIndex], 0),
  );
}

/**
 * Pixel heights for one bar's stacked segments, index-aligned with `values`.
 *
 * Every value > 0 gets at least its minimum (`minPx`, one number for all or
 * one per segment — a hatched segment needs more room for its stripes to
 * read), zeros get 0, and the total stays truthful: heights plus gaps always
 * sum to `barHeightPx`. The pixels a tiny segment gains come from the
 * segment(s) with the most room above their own minimum. Exact numbers live
 * in the tooltip and table. When even the minimums don't fit, the height is
 * split equally — at that size, presence is all a bar can show.
 */
export function allocateSegmentHeights(
  values: number[],
  barHeightPx: number,
  minPx: number | number[],
  gapPx: number,
): number[] {
  const minOf = (index: number) =>
    Array.isArray(minPx) ? (minPx[index] ?? 0) : minPx;
  const heights = values.map(() => 0);
  const nonzeroIndices = values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value > 0)
    .map((entry) => entry.index);
  if (nonzeroIndices.length === 0) return heights;

  const available = barHeightPx - gapPx * (nonzeroIndices.length - 1);
  const minTotal = nonzeroIndices.reduce((sum, index) => sum + minOf(index), 0);

  if (available <= minTotal) {
    // Degenerate: mins don't fit — equal split of whatever's left.
    const each = Math.max(0, available / nonzeroIndices.length);
    for (const index of nonzeroIndices) heights[index] = each;
    return heights;
  }

  const total = nonzeroIndices.reduce((sum, index) => sum + values[index], 0);
  for (const index of nonzeroIndices) {
    heights[index] = (values[index] / total) * available;
  }

  // Raise under-min segments to their minimum, then repay those pixels from
  // the segment(s) with the most headroom, never pushing one below its own
  // minimum. The feasibility check above guarantees enough headroom.
  let deficit = 0;
  for (const index of nonzeroIndices) {
    if (heights[index] < minOf(index)) {
      deficit += minOf(index) - heights[index];
      heights[index] = minOf(index);
    }
  }

  while (deficit > 1e-9) {
    let roomiest = nonzeroIndices[0];
    for (const index of nonzeroIndices) {
      if (heights[index] - minOf(index) > heights[roomiest] - minOf(roomiest))
        roomiest = index;
    }
    const headroom = heights[roomiest] - minOf(roomiest);
    if (headroom <= 0) break; // float edge cases only
    const take = Math.min(deficit, headroom);
    heights[roomiest] -= take;
    deficit -= take;
  }

  return heights;
}
