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
  /** Per period: no statement for a month between the card's first and last
   * ones — its spend is unknown, not zero (the value is 0, so nothing is
   * drawn; the breakdown and table say "no statement"). */
  missing: boolean[];
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

  // Each card's first and last month with a statement, across all history.
  const spanByCard = new Map<string, { first: string; last: string }>();
  for (const { cardId, period } of cycles) {
    const span = spanByCard.get(cardId);
    if (span === undefined)
      spanByCard.set(cardId, { first: period, last: period });
    else {
      if (period < span.first) span.first = period;
      if (period > span.last) span.last = period;
    }
  }
  const hasCycle = new Set(cycles.map((c) => cycleKey(c.cardId, c.period)));

  function valuesFor(cardId: string): number[] {
    // No cycle: 0 drawn. Before the first statement or after the last that
    // is truly nothing yet; in between, missingFor says it's unknown.
    return periods.map(
      (period) => spendByKey.get(cycleKey(cardId, period)) ?? 0,
    );
  }

  function missingFor(cardIds: string[]): boolean[] {
    return periods.map((period) =>
      cardIds.some((id) => {
        const span = spanByCard.get(id);
        return (
          span !== undefined &&
          period > span.first &&
          period < span.last &&
          !hasCycle.has(cycleKey(id, period))
        );
      }),
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
    missing: missingFor([card.id]),
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
      missing: missingFor(foldedCards.map((card) => card.id)),
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
 * Pixel heights for one bar's stacked segments, index-aligned with `values`,
 * plus the gap to draw between them.
 *
 * Proportional first: a ₹3,000 segment is drawn six times a ₹500 one. A
 * value > 0 is raised to its minimum (`minPx`, one number or one per
 * segment) only so it doesn't vanish, and only when that keeps the size
 * order — a smaller spend is never drawn as tall as a bigger one in the
 * same bar; otherwise the bar stays purely proportional. Gaps shrink on
 * short bars (at most 15% of the bar) rather than eat small segments.
 * Heights plus gaps always sum to `barHeightPx`, so the bar stays true to
 * the month total. Exact numbers live in the tooltip and table.
 */
export function allocateSegmentHeights(
  values: number[],
  barHeightPx: number,
  minPx: number | number[],
  gapPx: number,
): { heights: number[]; gap: number } {
  const minOf = (index: number) =>
    Array.isArray(minPx) ? (minPx[index] ?? 0) : minPx;
  const heights = values.map(() => 0);
  const nonzero = values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value > 0)
    .map((entry) => entry.index);
  if (nonzero.length === 0) return { heights, gap: gapPx };

  const gaps = nonzero.length - 1;
  const gap = gaps === 0 ? gapPx : Math.min(gapPx, (barHeightPx * 0.15) / gaps);
  const available = Math.max(0, barHeightPx - gap * gaps);
  const total = nonzero.reduce((sum, index) => sum + values[index], 0);
  for (const index of nonzero) {
    heights[index] = (values[index] / total) * available;
  }
  const proportional = heights.slice();

  // Raise under-min segments, then repay those pixels from the segment(s)
  // with the most room above their own minimum.
  let deficit = 0;
  for (const index of nonzero) {
    if (heights[index] < minOf(index)) {
      deficit += minOf(index) - heights[index];
      heights[index] = minOf(index);
    }
  }
  while (deficit > 1e-9) {
    let roomiest = nonzero[0];
    for (const index of nonzero) {
      if (heights[index] - minOf(index) > heights[roomiest] - minOf(roomiest))
        roomiest = index;
    }
    const headroom = heights[roomiest] - minOf(roomiest);
    if (headroom <= 1e-9) return { heights: proportional, gap }; // mins don't fit
    const take = Math.min(deficit, headroom);
    heights[roomiest] -= take;
    deficit -= take;
  }

  // The minimums must not reorder sizes: a smaller value drawn at least as
  // tall as a bigger one misleads more than a thin sliver does.
  for (const a of nonzero) {
    for (const b of nonzero) {
      if (values[a] < values[b] && heights[a] >= heights[b] - 1e-9) {
        return { heights: proportional, gap };
      }
    }
  }
  return { heights, gap };
}
