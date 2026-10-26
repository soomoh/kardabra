import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { CSSProperties } from 'react';
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
// Below this a 2px outline would fill the box and read as solid (paid):
// a 1px outline keeps a short unpaid segment hollow.
const THIN_HATCH_BELOW_PX = 10;
// Visibility floors, small so they don't distort sizes: a ₹500 spend must
// not look like a ₹3,000 one. lib/trends.ts's allocateSegmentHeights
// applies them only when the size order survives.
const MIN_SEGMENT_PX = 2;
const MIN_HATCHED_PX = 4;

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

/** The month whose breakdown is showing, where to anchor it (px, in the
 * section's box), and what opened it: `hover` follows the mouse away,
 * `focus` lasts while the month has keyboard focus, `pin` (a tap, click or
 * Enter) stays until dismissed. */
interface Tooltip {
  periodIndex: number;
  x: number;
  y: number;
  mode: 'hover' | 'focus' | 'pin';
}

function TrendsChart({ trends }: TrendsChartProps) {
  const [excludedCardIds, setExcludedCardIds] = useState<Set<string>>(
    new Set(),
  );
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  // Centre the breakdown over its month, but keep the whole box inside the
  // panel: measured after render, since its width depends on the names.
  useLayoutEffect(() => {
    const box = tooltipRef.current;
    const panel = containerRef.current;
    if (box === null || panel === null || tooltip === null) return;
    const edge = 8;
    const left = Math.min(
      Math.max(edge, tooltip.x - box.offsetWidth / 2),
      panel.clientWidth - box.offsetWidth - edge,
    );
    box.style.left = `${Math.max(edge, left)}px`;
    // It opens upward from its anchor; never past the panel's top.
    box.style.top = `${Math.max(tooltip.y, box.offsetHeight + edge)}px`;
  }, [tooltip]);
  // While open: Escape closes it wherever focus is, and a tap or click
  // outside the month columns closes a pinned one (a tap doesn't always
  // move focus, so blur alone can't be relied on).
  useEffect(() => {
    if (tooltip === null) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setTooltip(null);
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Element | null;
      if (!target?.closest?.('.trends-hit')) setTooltip(null);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [tooltip]);
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
    setTooltip(null); // its totals and position change with the stack
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

  /** Show a month's breakdown, anchored over its bar. A whole month column
   * is the target — however thin its segments, it's easy to hit with a
   * finger, and one tab stop per month instead of per segment. */
  function showMonth(
    target: SVGElement,
    periodIndex: number,
    mode: Tooltip['mode'],
  ) {
    const containerRect = containerRef.current?.getBoundingClientRect();
    const svgRect = target.ownerSVGElement?.getBoundingClientRect();
    if (containerRect === undefined || svgRect === undefined) return;
    setTooltip({
      periodIndex,
      x:
        svgRect.left -
        containerRect.left +
        MARGIN_LEFT +
        slotWidth * (periodIndex + 0.5),
      y:
        svgRect.top -
        containerRect.top +
        chartBottom -
        yForValue(monthTotals[periodIndex]) -
        24,
      mode,
    });
  }

  /** A month's cards with spend, biggest first, as the tooltip lists them. */
  function monthBreakdown(periodIndex: number) {
    return visibleSeries
      .map((series) => ({
        series,
        value: series.values[periodIndex],
        unpaid: series.unpaid[periodIndex],
        // No statement that month: unknown, listed last, never as ₹0.
        missing: series.missing[periodIndex],
      }))
      .filter((entry) => entry.value > 0 || entry.missing)
      .sort(
        (a, b) => Number(a.missing) - Number(b.missing) || b.value - a.value,
      );
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
              // A group, not an image: its segments are focusable and
              // labelled, which an img role would hide.
              role="group"
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

                // Segment heights come from the tested helper in
                // lib/trends.ts: proportional, with small visibility floors
                // that never reorder sizes; the bar's total stays true.
                const periodValues = visibleSeries.map(
                  (series) => series.values[periodIndex],
                );
                const { heights: segmentHeights, gap } = allocateSegmentHeights(
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
                  const { series, unpaid, height } = entry;
                  const top = stackCursor - height;
                  stackCursor = top - gap;

                  const color = colorVarFor(
                    trends.series.indexOf(series),
                    series,
                  );
                  // A hatched segment's outline is drawn inside its box, so
                  // paid and unpaid segments of the same value match in size.
                  const stroke =
                    height < THIN_HATCH_BELOW_PX ? 1 : HATCH_STROKE;
                  const inset = unpaid ? stroke / 2 : 0;
                  const radius = Math.min(
                    SEGMENT_RADIUS,
                    height / 2,
                    barWidth / 2,
                  );
                  return (
                    <rect
                      key={series.cardId ?? 'other'}
                      className="trends-segment"
                      x={barX + inset}
                      y={top + inset}
                      width={barWidth - inset * 2}
                      // At least 1px drawn, so every spend leaves a mark.
                      height={Math.max(1, height - inset * 2)}
                      rx={Math.max(0, radius - inset)}
                      fill={unpaid ? `url(#${hatchId(series)})` : color}
                      stroke={unpaid ? color : undefined}
                      strokeWidth={unpaid ? stroke : undefined}
                      aria-hidden="true"
                    />
                  );
                });

                const monthTotal = monthTotals[periodIndex];
                const axis = periodAxisLabel(period);

                const breakdown = monthBreakdown(periodIndex);
                const active = tooltip?.periodIndex === periodIndex;
                const monthLabel = `${formatPeriodLabel(period)}: ${formatINR(monthTotal)}${breakdown
                  .map(
                    (e) =>
                      `; ${e.series.nickname} ${e.missing ? 'no statement' : formatINR(e.value)}${e.unpaid ? ', not paid yet' : ''}`,
                  )
                  .join('')}`;

                return (
                  <g key={period}>
                    {active && (
                      <rect
                        className="trends-band"
                        x={slotX}
                        y={MARGIN_TOP}
                        width={slotWidth}
                        height={chartHeight}
                        rx={SEGMENT_RADIUS}
                        aria-hidden="true"
                      />
                    )}
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
                    {/* The month's hit target: its whole column, labels
                        included. Hover follows the mouse; a tap or click
                        pins it; Escape closes it. */}
                    {monthTotal > 0 && (
                      <rect
                        className="trends-hit"
                        x={slotX}
                        y={MARGIN_TOP}
                        width={slotWidth}
                        height={CHART_HEIGHT - MARGIN_TOP}
                        fill="transparent"
                        tabIndex={0}
                        role="img"
                        aria-label={monthLabel}
                        onPointerEnter={(e) => {
                          // The mouse never takes over a pinned or
                          // keyboard-opened breakdown.
                          if (
                            e.pointerType === 'mouse' &&
                            (tooltip === null || tooltip.mode === 'hover')
                          )
                            showMonth(e.currentTarget, periodIndex, 'hover');
                        }}
                        onPointerLeave={(e) => {
                          if (
                            e.pointerType === 'mouse' &&
                            tooltip?.mode === 'hover'
                          )
                            setTooltip(null);
                        }}
                        onClick={(e) =>
                          active && tooltip?.mode === 'pin'
                            ? setTooltip(null)
                            : showMonth(e.currentTarget, periodIndex, 'pin')
                        }
                        onFocus={(e) =>
                          showMonth(e.currentTarget, periodIndex, 'focus')
                        }
                        onBlur={() => setTooltip(null)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            if (active && tooltip?.mode === 'pin')
                              setTooltip(null);
                            else showMonth(e.currentTarget, periodIndex, 'pin');
                          }
                        }}
                      />
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {tooltip !== null && tooltip.periodIndex < trends.periods.length && (
            <div
              className="trends-tooltip"
              ref={tooltipRef}
              style={{ left: tooltip.x, top: tooltip.y }}
            >
              <div className="trends-tooltip-title">
                {formatPeriodLabel(trends.periods[tooltip.periodIndex])}
              </div>
              <ul>
                {monthBreakdown(tooltip.periodIndex).map((entry) => (
                  <li key={entry.series.cardId ?? 'other'}>
                    <span
                      className={
                        entry.unpaid ? 'legend-swatch hatch' : 'legend-swatch'
                      }
                      style={
                        {
                          '--swatch': colorVarFor(
                            trends.series.indexOf(entry.series),
                            entry.series,
                          ),
                        } as CSSProperties
                      }
                      aria-hidden="true"
                    />
                    <span>
                      {entry.series.nickname}
                      {entry.unpaid && (
                        <span className="muted">, not paid yet</span>
                      )}
                    </span>
                    {entry.missing ? (
                      <span className="muted amount">No statement</span>
                    ) : (
                      <strong className="amount">
                        {formatINR(entry.value)}
                      </strong>
                    )}
                  </li>
                ))}
              </ul>
              <div className="trends-tooltip-total">
                <span>Total</span>
                <strong className="amount">
                  {formatINR(monthTotals[tooltip.periodIndex])}
                </strong>
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
        // Pressed = shown on the chart; the name stays the card's.
        aria-pressed={onToggle === undefined ? undefined : !dimmed}
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
      <table className="txn-table" aria-label="Monthly spend by card">
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
                  {series.missing[periodIndex] ? (
                    <span className="muted">No statement</span>
                  ) : (
                    formatINR(series.values[periodIndex])
                  )}
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
