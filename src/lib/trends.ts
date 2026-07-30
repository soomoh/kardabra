/**
 * The spend-trends chart's data transform, kept entirely separate from
 * TrendsChart.tsx so the "which months, which cards, how much each"
 * question is a plain function testable without a DOM (test the seam,
 * not the surface — same split as sortCards.ts/unpaidSummary.ts feeding
 * CardTile/Dashboard).
 *
 * Each card's monthly value is that period's cycle.spend — read straight
 * from the stored CycleRecord, never recomputed here from transactions.
 * cycle.spend is the single source of truth for "what did this cycle
 * cost" (see schema.ts's CycleRecord.spend comment): it's produced by
 * db.ts's recomputeCardSpends, which knows the full cross-statement
 * priorExpectedDue chain and any per-cycle user override that this
 * module has no way to reconstruct on its own (it never sees raw
 * transactions at all). Reading the stored value instead of re-deriving
 * it is what guarantees the chart, the dashboard tile, and CardDetail's
 * statement rows can never disagree about what a given month "cost".
 */

// 6 months, not 12: the latest months must always be visible without
// horizontal scroll on a small phone (target: iPhone SE, 375px CSS
// width) — 12 slots at that width either crush below readability or
// force a scroll that hides the most recent, most interesting bars
// behind it.
const TRAILING_MONTHS = 6;
const MAX_NAMED_SERIES = 8;

export interface TrendsCard {
  id: string;
  nickname: string;
  createdAt: string; // ISO date-time — the stable ordering key, see below
}

/** The structural slice of CycleRecord this module needs — kept as its
 * own local interface (rather than importing CycleRecord from db/schema)
 * so this file stays a plain, DB-decoupled function: any object shaped
 * like this works, including a full CycleRecord, without lib/ needing to
 * depend on db/. */
export interface TrendsCycle {
  cardId: string;
  period: string; // 'YYYY-MM'
  /** undefined for a cycle that was never computed (e.g. a 'predicted'
   * cycle with no statement behind it yet) — treated as 0 below. There's
   * no "unknown" state to preserve here the way CycleRecord.totalDue's
   * undefined matters elsewhere: a trend bar is always drawable at 0. */
  spend?: number;
}

/** One series' values, one per period in `MonthlyTrends.periods`, same
 * order/length. `cardId: null` marks the single folded 'Other' bucket
 * (9th+ card by createdAt) — there's no one card to attribute or toggle
 * it to, unlike every other series (same "sentinel, not a discriminated
 * union" choice as CycleRecord.dueDateISO: a plain nullable field beats
 * an extra type name for one binary case). */
export interface TrendSeries {
  cardId: string | null;
  nickname: string;
  values: number[];
}

export interface MonthlyTrends {
  /** 'YYYY-MM', oldest to newest. Always the trailing TRAILING_MONTHS
   * calendar months ending at the latest cycle's period — empty array if
   * there are no cycles at all (nothing to trend). */
  periods: string[];
  /** Cards ordered by createdAt ascending (oldest card first), then the
   * folded 'Other' bucket last if there were more than 8 cards. Stable
   * regardless of dashboard sort order, spend size, or anything else
   * that changes over time — color assignment in TrendsChart.tsx walks
   * this same order, and a series' color must follow the entity it
   * represents, never its rank by spend or recency: if a fluctuating
   * "biggest spender this month" rank picked the color, toggling one
   * card off would repaint every other bar's color as ranks shifted,
   * which is exactly the kind of surprise a legend must never produce. */
  series: TrendSeries[];
  /** Sum across every series (including Other), one per period. */
  monthTotals: number[];
}

/** The TRAILING_MONTHS consecutive 'YYYY-MM' periods ending at (and
 * including) `latestPeriod`, oldest first. Plain calendar-field stepping
 * (no Date-epoch math) for the same reasons lib/dates.ts avoids it. */
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

/** `${cardId} ${period}` — a compound map key built with a
 * character (' ') that can never appear in either a card's uuid or
 * a 'YYYY-MM' period string, so two different (cardId, period) pairs can
 * never collide onto the same key by accident. */
function cycleKey(cardId: string, period: string): string {
  return `${cardId} ${period}`;
}

/**
 * Build the trailing per-card spend series (TRAILING_MONTHS periods).
 *
 * `cycles` is every cycle across every card being charted (flat, like
 * getAllCycles) — this module reads each one's already-computed `spend`
 * directly rather than deriving it, so the chart can never disagree with
 * what CardDetail or the dashboard tile shows for that same cycle (see
 * this file's header comment).
 */
export function monthlyTrends(
  cards: TrendsCard[],
  cycles: TrendsCycle[],
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

  // One spend value per (card, period) inside the trailing window — a
  // cycle is at most one per (cardId, period) by construction (`cycles`'s
  // own store key IS [cardId, period] — see schema.ts), so this map has
  // no collision to worry about.
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
    // A month with no cycle for this card is a true zero (nothing billed
    // that month), not "unknown" — there's no sentinel needed here the
    // way CycleRecord.totalDue needs one, because a trend chart bar is
    // always drawable at 0.
    return periods.map(
      (period) => spendByKey.get(cycleKey(cardId, period)) ?? 0,
    );
  }

  const series: TrendSeries[] = namedCards.map((card) => ({
    cardId: card.id,
    nickname: card.nickname,
    values: valuesFor(card.id),
  }));

  if (foldedCards.length > 0) {
    const foldedValues = periods.map((_, periodIndex) =>
      foldedCards.reduce(
        (sum, card) => sum + (valuesFor(card.id)[periodIndex] ?? 0),
        0,
      ),
    );
    series.push({ cardId: null, nickname: 'Other', values: foldedValues });
  }

  const monthTotals = periods.map((_, periodIndex) =>
    series.reduce((sum, s) => sum + s.values[periodIndex], 0),
  );

  return { periods, series, monthTotals };
}

/**
 * Month totals recomputed over a subset of `series` — the legend's
 * "click to toggle a card off" behavior, pulled out as a pure function so
 * the toggle arithmetic is unit-testable without
 * mounting TrendsChart. Excluding a card never changes any other card's
 * own values or color (see MonthlyTrends.series's comment) — only which
 * bars get summed into the totals shown above each bar.
 */
export function visibleMonthTotals(
  series: TrendSeries[],
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
 * Pixel heights for one bar's stacked segments, with a minimum visible
 * height for every nonzero value.
 *
 * Naive proportional scaling breaks down for small values: two cards
 * with small spends in one month could otherwise render as one visible
 * sliver and one vanished bar, when its proportional height fell
 * at/below the 2px gap subtraction. A chart that silently drops a real
 * value is worse than one that draws it slightly over-scale, so:
 *
 *   - every value > 0 gets at least `minPx` of rendered height;
 *   - every value === 0 gets exactly 0 (a zero is genuinely nothing —
 *     no phantom slivers);
 *   - the bar's TOTAL height stays truthful: rendered heights plus the
 *     `gapPx` gaps between adjacent nonzero segments always sum to
 *     `barHeightPx` (the month total's scaled height). The pixels a
 *     tiny segment gains are taken from the LARGEST segment(s), not by
 *     growing the bar — so tiny values render deliberately over-scale
 *     while big ones render imperceptibly under-scale. That's the
 *     trade-off chosen on purpose: the eye can't tell 61% from 60%, but
 *     it absolutely notices a card that isn't there. The exact numbers
 *     live in the tooltip and the table view, which stay unrounded.
 *
 * Degenerate case: when `barHeightPx` can't fit every nonzero segment
 * at `minPx` plus the gaps (a very short bar with many tiny series),
 * proportionality is abandoned entirely and the available height is
 * split equally — every value stays visible, which at that size is the
 * only information the bar can still carry.
 *
 * Returned array is index-aligned with `values`.
 */
export function allocateSegmentHeights(
  values: number[],
  barHeightPx: number,
  minPx: number,
  gapPx: number,
): number[] {
  const heights = values.map(() => 0);
  const nonzeroIndices = values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value > 0)
    .map((entry) => entry.index);
  if (nonzeroIndices.length === 0) return heights;

  // The height left for actual segments once the surface gaps between
  // adjacent nonzero segments are carved out of the bar's total.
  const available = barHeightPx - gapPx * (nonzeroIndices.length - 1);

  if (available <= minPx * nonzeroIndices.length) {
    // Degenerate: mins don't fit — equal split of whatever's left.
    const each = Math.max(0, available / nonzeroIndices.length);
    for (const index of nonzeroIndices) heights[index] = each;
    return heights;
  }

  const total = nonzeroIndices.reduce((sum, index) => sum + values[index], 0);
  for (const index of nonzeroIndices) {
    heights[index] = (values[index] / total) * available;
  }

  // Raise every under-min segment to minPx, remembering how many pixels
  // that borrowed...
  let deficit = 0;
  for (const index of nonzeroIndices) {
    if (heights[index] < minPx) {
      deficit += minPx - heights[index];
      heights[index] = minPx;
    }
  }

  // ...then repay the borrowed pixels from the largest segment(s):
  // take everything from the current largest first, spilling over to
  // the next-largest only if taking more would push it below minPx
  // itself. Terminates because the feasibility check above guarantees
  // enough above-min headroom exists in total.
  while (deficit > 1e-9) {
    let largestIndex = nonzeroIndices[0];
    for (const index of nonzeroIndices) {
      if (heights[index] > heights[largestIndex]) largestIndex = index;
    }
    const headroom = heights[largestIndex] - minPx;
    if (headroom <= 0) break; // unreachable given the feasibility check; guards float edge cases
    const take = Math.min(deficit, headroom);
    heights[largestIndex] -= take;
    deficit -= take;
  }

  return heights;
}
