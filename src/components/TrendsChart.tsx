import { useCallback, useId, useRef, useState } from 'react';
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  FocusEvent,
} from 'react';
import type { MonthlyTrends, TrendSeries } from '../lib/trends';
import { visibleMonthTotals, allocateSegmentHeights } from '../lib/trends';
import { formatINR, formatINRCompact } from '../lib/money';
import { formatPeriodLabel, periodAxisLabel } from '../lib/dates';

/**
 * Hand-rolled SVG stacked-bar chart, no charting library — a 6-bar
 * stacked chart is small enough that a library would cost more in bundle
 * size and API-learning than it saves in code. Every number this
 * component draws comes pre-computed from lib/trends.ts's monthlyTrends;
 * this file only turns those numbers into SVG coordinates and handles
 * hover/toggle/table-view state. The geometry with real failure modes
 * (minimum segment heights) is lib/trends.ts's allocateSegmentHeights.
 *
 * Look (DESIGN.md): each card's spend is a rounded capsule, stacked with
 * surface-coloured gaps; a month whose bill is still unpaid is hatched in
 * the card's colour. The --series-* palette is validated in tokens.css;
 * its contrast WARNs are why the table view is not optional.
 */

interface TrendsChartProps {
  trends: MonthlyTrends;
}

// The drawing is sized from the container's measured width (not scaled by
// a fixed viewBox), so text stays at its real pixel size on every screen.
// 340px is an iPhone SE's content column; narrower scrolls sideways.
const MIN_CHART_WIDTH = 340;
const CHART_HEIGHT = 280;
const MAX_BAR_WIDTH = 56; // px — chunky capsules, not slabs, on wide screens
const MARGIN_LEFT = 52;
const MARGIN_RIGHT = 8;
const MARGIN_TOP = 30; // room for the month-total direct label above each bar
const MARGIN_BOTTOM = 40; // month label + the year under it
const GRIDLINE_COUNT = 3; // 4 lines total (0, 1/3, 2/3, 3/3 of the top value) — "~4 y-gridlines"
const SEGMENT_GAP = 3; // px, in --chart-surface — the spacer between stacked segments
const SEGMENT_RADIUS = 7; // px, every segment is a capsule (capped at half its size)
const BAR_WIDTH_RATIO = 0.6; // bar width as a fraction of its month slot
const HATCH_STROKE = 2; // px outline around a hatched (unpaid) segment
// No nonzero segment may render shorter than this — a real small spend
// must stay visible instead of vanishing under gap subtraction. The
// reallocation arithmetic lives in lib/trends.ts's allocateSegmentHeights.
const MIN_SEGMENT_PX = 4;
// A hatched (unpaid) segment needs room for its outline and at least one
// visible stripe; any thinner and it reads as solid, i.e. as paid.
const MIN_HATCHED_PX = 12;

/** The smallest "nice" (1/2/5 * 10^n) ceiling for `max`, used as the top
 * gridline so the four gridlines land on round numbers instead of
 * whatever the largest bar happens to total. Returns at least 1 so a
 * chart with every value at 0 still has a scale instead of dividing by
 * zero. */
function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const residual = max / magnitude;
  const niceResidual =
    residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
  return niceResidual * magnitude;
}

interface Tooltip {
  x: number;
  y: number;
  nickname: string;
  period: string;
  value: number;
  unpaid: boolean;
  monthTotal: number;
}

function TrendsChart({ trends }: TrendsChartProps) {
  const [excludedCardIds, setExcludedCardIds] = useState<Set<string>>(
    new Set(),
  );
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const patternPrefix = useId();
  const [svgWidth, setChartWidth] = useState(MIN_CHART_WIDTH);
  // Callback ref (re-attached when the table view swaps the chart out);
  // React 19 runs the returned cleanup on detach.
  const measureRef = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) =>
      setChartWidth(
        Math.max(MIN_CHART_WIDTH, Math.floor(entry.contentRect.width)),
      ),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (trends.periods.length === 0) return null;

  function toggleCard(cardId: string) {
    setExcludedCardIds((current) => {
      const next = new Set(current);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  }

  // Recomputed on every toggle, not stored: excluding a card must remove
  // its segments from the stack entirely (constraint 5's "recompute
  // stacks without it"), not just dim them, so both the geometry below
  // and the direct labels are built from this filtered list.
  const visibleSeries = trends.series.filter(
    (s) => s.cardId === null || !excludedCardIds.has(s.cardId),
  );
  const monthTotals = visibleMonthTotals(trends.series, excludedCardIds);
  const chartMax = niceCeiling(Math.max(0, ...monthTotals));

  const chartWidth = svgWidth - MARGIN_LEFT - MARGIN_RIGHT;
  const chartHeight = CHART_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const chartBottom = MARGIN_TOP + chartHeight;
  const slotWidth = chartWidth / trends.periods.length;
  const barWidth = Math.min(slotWidth * BAR_WIDTH_RATIO, MAX_BAR_WIDTH);

  function yForValue(value: number): number {
    return (value / chartMax) * chartHeight;
  }

  function showTooltip(
    event: ReactPointerEvent | FocusEvent,
    nickname: string,
    period: string,
    value: number,
    unpaid: boolean,
    periodIndex: number,
  ) {
    const containerRect = containerRef.current?.getBoundingClientRect();
    const targetRect = event.currentTarget.getBoundingClientRect();
    if (containerRect === undefined) return;
    setTooltip({
      x: targetRect.left + targetRect.width / 2 - containerRect.left,
      y: targetRect.top - containerRect.top,
      nickname,
      period,
      value,
      unpaid,
      monthTotal: monthTotals[periodIndex],
    });
  }

  const gridlines = Array.from({ length: GRIDLINE_COUNT + 1 }, (_, i) => {
    const value = (chartMax / GRIDLINE_COUNT) * i;
    return { value, y: chartBottom - yForValue(value) };
  });

  const hatchId = (series: TrendSeries) =>
    `${patternPrefix}-hatch-${trends.series.indexOf(series)}`;
  const anyUnpaid = visibleSeries.some((s) => s.unpaid.some(Boolean));

  return (
    <section className="trends-section" ref={containerRef}>
      <div className="trends-header">
        <h2>Spend trends</h2>
        <button onClick={() => setView(view === 'chart' ? 'table' : 'chart')}>
          {view === 'chart' ? 'View as table' : 'View as chart'}
        </button>
      </div>

      {view === 'chart' && (
        <>
          <ul className="trends-legend">
            {trends.series.length >= 2 &&
              trends.series.map((series, index) => (
                <LegendChip
                  key={series.cardId ?? 'other'}
                  series={series}
                  colorVar={colorVarFor(index, series)}
                  dimmed={
                    series.cardId !== null && excludedCardIds.has(series.cardId)
                  }
                  onToggle={
                    series.cardId === null
                      ? undefined
                      : () => toggleCard(series.cardId!)
                  }
                />
              ))}
            {anyUnpaid && (
              <li className="legend-key">
                <span className="legend-swatch hatch" aria-hidden="true" />
                Not paid yet
              </li>
            )}
          </ul>

          <div className="trends-chart-scroll" ref={measureRef}>
            <svg
              width={svgWidth}
              height={CHART_HEIGHT}
              viewBox={`0 0 ${svgWidth} ${CHART_HEIGHT}`}
              role="img"
              aria-label="Monthly spend by card, last 6 months"
            >
              <defs>
                {visibleSeries.map((series) => (
                  <pattern
                    key={series.cardId ?? 'other'}
                    id={hatchId(series)}
                    width={6}
                    height={6}
                    patternUnits="userSpaceOnUse"
                    patternTransform="rotate(45)"
                  >
                    <rect width={6} height={6} fill="var(--chart-surface)" />
                    <rect
                      width={2.5}
                      height={6}
                      fill={colorVarFor(trends.series.indexOf(series), series)}
                    />
                  </pattern>
                ))}
              </defs>
              {gridlines.map(({ value, y }) => (
                <g key={value}>
                  <line
                    x1={MARGIN_LEFT}
                    x2={svgWidth - MARGIN_RIGHT}
                    y1={y}
                    y2={y}
                    stroke={value === 0 ? 'var(--line-strong)' : 'var(--line)'}
                    strokeWidth={value === 0 ? 1.5 : 1}
                    strokeDasharray={value === 0 ? undefined : '3 5'}
                  />
                  <text
                    x={MARGIN_LEFT - 8}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize={12}
                    fill="var(--ink-muted)"
                  >
                    {formatINRCompact(value)}
                  </text>
                </g>
              ))}

              {trends.periods.map((period, periodIndex) => {
                const slotX = MARGIN_LEFT + slotWidth * periodIndex;
                const barX = slotX + (slotWidth - barWidth) / 2;

                // Segment heights come from the tested reallocation
                // helper (lib/trends.ts): every nonzero value gets at
                // least MIN_SEGMENT_PX, the extra pixels come out of the
                // largest segment(s), and the bar's total height stays
                // truthful to the month total — a small-but-real value
                // never gets swallowed by gap subtraction.
                const periodValues = visibleSeries.map(
                  (series) => series.values[periodIndex],
                );
                const segmentHeights = allocateSegmentHeights(
                  periodValues,
                  yForValue(monthTotals[periodIndex]),
                  visibleSeries.map((series) =>
                    series.unpaid[periodIndex]
                      ? MIN_HATCHED_PX
                      : MIN_SEGMENT_PX,
                  ),
                  SEGMENT_GAP,
                );

                // Stack largest-first from the baseline: big spends sit at
                // the bottom and small ones at the top, in the same size order
                // every month regardless of card. Colour still identifies the
                // card (see colorVarFor), so reordering the stack never changes
                // which card a segment belongs to. Zero-value series drop out
                // entirely — no mark, no gap.
                const stacked = visibleSeries
                  .map((series, seriesIndex) => ({
                    series,
                    value: series.values[periodIndex],
                    unpaid: series.unpaid[periodIndex],
                    height: segmentHeights[seriesIndex],
                  }))
                  .filter((entry) => entry.height > 0)
                  .sort((a, b) => b.value - a.value);

                let stackCursor = chartBottom; // y of the next segment's bottom edge
                const segments = stacked.map((entry) => {
                  const { series, value, unpaid, height } = entry;
                  const top = stackCursor - height;
                  stackCursor = top - SEGMENT_GAP;

                  const color = colorVarFor(
                    trends.series.indexOf(series),
                    series,
                  );
                  // A hatched segment's outline is drawn inside its box, so
                  // paid and unpaid segments of the same value match in size.
                  const inset = unpaid ? HATCH_STROKE / 2 : 0;
                  const radius = Math.min(
                    SEGMENT_RADIUS,
                    height / 2,
                    barWidth / 2,
                  );
                  const label = `${series.nickname}, ${formatPeriodLabel(period)}: ${formatINR(value)}${unpaid ? ', not paid yet' : ''}`;
                  const show = (e: ReactPointerEvent | FocusEvent) =>
                    showTooltip(
                      e,
                      series.nickname,
                      period,
                      value,
                      unpaid,
                      periodIndex,
                    );

                  return (
                    <rect
                      key={series.cardId ?? 'other'}
                      className="trends-segment"
                      x={barX + inset}
                      y={top + inset}
                      width={barWidth - inset * 2}
                      height={Math.max(0, height - inset * 2)}
                      rx={Math.max(0, radius - inset)}
                      fill={unpaid ? `url(#${hatchId(series)})` : color}
                      stroke={unpaid ? color : undefined}
                      strokeWidth={unpaid ? HATCH_STROKE : undefined}
                      tabIndex={0}
                      role="img"
                      aria-label={label}
                      onPointerEnter={show}
                      onPointerMove={show}
                      onPointerLeave={() => setTooltip(null)}
                      onFocus={show}
                      onBlur={() => setTooltip(null)}
                    />
                  );
                });

                const monthTotal = monthTotals[periodIndex];
                const axis = periodAxisLabel(period);

                return (
                  <g key={period}>
                    {segments}
                    <text
                      x={slotX + slotWidth / 2}
                      y={chartBottom - yForValue(monthTotal) - 8}
                      textAnchor="middle"
                      fontSize={slotWidth < 60 ? 11 : 12}
                      fontWeight={600}
                      fill="var(--ink)"
                    >
                      {monthTotal > 0 ? formatINRCompact(monthTotal) : ''}
                    </text>
                    <text
                      x={slotX + slotWidth / 2}
                      y={chartBottom + 17}
                      textAnchor="middle"
                      fontSize={12}
                      fill="var(--ink-muted)"
                    >
                      <tspan>{axis.month}</tspan>
                      {/* The year only where it changes, so six months fit
                          a phone without labels colliding. */}
                      {(periodIndex === 0 || axis.month === 'Jan') && (
                        <tspan x={slotX + slotWidth / 2} dy={14}>
                          {axis.year}
                        </tspan>
                      )}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {tooltip !== null && (
            <div
              className="trends-tooltip"
              style={{
                left: tooltip.x,
                top: tooltip.y,
                transform: 'translate(-50%, -100%)',
              }}
            >
              <div>
                {tooltip.nickname}, {formatPeriodLabel(tooltip.period)}:{' '}
                <strong>{formatINR(tooltip.value)}</strong>
              </div>
              {tooltip.unpaid && <div>Not paid yet</div>}
              <div className="muted">
                Month total {formatINR(tooltip.monthTotal)}
              </div>
            </div>
          )}
        </>
      )}

      {view === 'table' && <TrendsTable trends={trends} />}
    </section>
  );
}

/** Series index (its position in `trends.series`, which is always card-
 * createdAt order with 'Other' last — see lib/trends.ts) maps 1:1 to a
 * --series-N custom property, EXCEPT the folded 'Other' bucket, which
 * never gets a 9th generated hue — it's always var(--series-other). */
function colorVarFor(index: number, series: TrendSeries): string {
  return series.cardId === null
    ? 'var(--series-other)'
    : `var(--series-${index + 1})`;
}

interface LegendChipProps {
  series: TrendSeries;
  colorVar: string;
  dimmed: boolean;
  onToggle: (() => void) | undefined;
}

function LegendChip({ series, colorVar, dimmed, onToggle }: LegendChipProps) {
  return (
    <li>
      <button
        type="button"
        className="legend-chip"
        onClick={onToggle}
        disabled={onToggle === undefined}
        // Pressed = hidden from the chart.
        aria-pressed={onToggle === undefined ? undefined : dimmed}
        aria-label={
          onToggle === undefined
            ? undefined
            : `${dimmed ? 'Show' : 'Hide'} ${series.nickname}`
        }
      >
        <span
          className="legend-swatch"
          style={{ '--swatch': colorVar } as CSSProperties}
          aria-hidden="true"
        />
        {series.nickname}
      </button>
    </li>
  );
}

/** The relief view: every number the chart draws, as a plain table, so
 * the light-mode palette's documented contrast WARN (see this file's
 * header comment) never gates a reader who can't tell two hues apart.
 * Always shows the full (untoggled) data — the legend's toggle is a
 * chart-only convenience, not a second filter to keep in sync with a
 * table that already shows everything. */
function TrendsTable({ trends }: { trends: MonthlyTrends }) {
  return (
    <div className="table-scroll">
      <table className="txn-table">
        <thead>
          <tr>
            <th>Month</th>
            {trends.series.map((series) => (
              <th key={series.cardId ?? 'other'} className="num">
                {series.nickname}
              </th>
            ))}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {trends.periods.map((period, periodIndex) => (
            <tr key={period}>
              <td className="nowrap">{formatPeriodLabel(period)}</td>
              {trends.series.map((series) => (
                <td key={series.cardId ?? 'other'} className="num">
                  {formatINR(series.values[periodIndex])}
                </td>
              ))}
              <td className="num">
                {formatINR(trends.monthTotals[periodIndex])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default TrendsChart;
