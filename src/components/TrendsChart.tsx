import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, FocusEvent } from 'react';
import type { MonthlyTrends, TrendSeries } from '../lib/trends';
import { visibleMonthTotals, allocateSegmentHeights } from '../lib/trends';
import { formatINR, formatINRCompact } from '../lib/money';
import { formatPeriodLabel } from '../lib/dates';

/**
 * Hand-rolled SVG stacked-bar chart, no charting library — a 6-bar
 * stacked chart is small enough that a library would cost more in bundle
 * size and API-learning than it saves in code. Every number this
 * component draws comes pre-computed from lib/trends.ts's monthlyTrends
 * — this file only turns those numbers into SVG coordinates and handles
 * hover/toggle/table-view interaction state; the one piece of geometry
 * arithmetic with real failure modes (minimum segment heights) lives in
 * lib/trends.ts's allocateSegmentHeights, tested as a pure function.
 *
 * The categorical palette (--series-1..8 in index.css) is pre-validated
 * by a color-formula contrast/CVD checker against both chart surfaces.
 * Light mode carries a documented contrast WARN on 3 of the 8 hues
 * (below 3:1 against a white surface) — relief for that WARN is visible
 * labels or a table view, which is exactly why the "View as table"
 * toggle below is not optional polish: it's what makes the light-mode
 * palette legitimate to ship. Dark mode carries a CVD-separation WARN in
 * the 8-12 floor band, legal only with secondary encoding — covered by
 * the 2px surface gaps between segments and the always-present legend,
 * both required regardless of palette. None of the eight hex values may
 * be edited (see index.css's comment) — do not "fix" either WARN by
 * tweaking a color.
 */

interface TrendsChartProps {
  trends: MonthlyTrends;
}

// Sized for 6 months (see lib/trends.ts's TRAILING_MONTHS comment): the
// viewBox is narrow enough that at the CSS min-width (340px, fitting an
// iPhone SE's ~343px content column without overflow-x) the scale factor
// stays near 0.7, keeping axis text legible instead of shrinking to
// illegibility with more months in the same width.
const VIEWBOX_WIDTH = 480;
const VIEWBOX_HEIGHT = 300;
const MARGIN_LEFT = 52;
const MARGIN_RIGHT = 8;
const MARGIN_TOP = 30; // room for the month-total direct label above each bar
const MARGIN_BOTTOM = 24;
const GRIDLINE_COUNT = 3; // 4 lines total (0, 1/3, 2/3, 3/3 of the top value) — "~4 y-gridlines"
const SEGMENT_GAP = 2; // px, in --chart-surface — the spacer between stacked segments
const TOP_RADIUS = 4; // px, rounded top corners on the topmost segment only
const BAR_WIDTH_RATIO = 0.65; // bar width as a fraction of its month slot (60-70% target)
// No nonzero segment may render shorter than this — a real small spend
// must stay visible instead of vanishing under gap subtraction. The
// reallocation arithmetic lives in lib/trends.ts's allocateSegmentHeights.
const MIN_SEGMENT_PX = 4;

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

/** An SVG path for a bar segment: rounded top corners when `topRadius` >
 * 0, flat/square otherwise (used for every segment except the topmost of
 * each stack, which stays anchored square to whatever's below it — only
 * the very top of a stack, and the whole stack's flat baseline, are real
 * edges of the mark; every other boundary is a gap, not a corner). */
function segmentPath(
  x: number,
  y: number,
  width: number,
  height: number,
  topRadius: number,
): string {
  if (height <= 0) return '';
  const r = Math.min(topRadius, height, width / 2);
  if (r <= 0) {
    return `M${x},${y} h${width} v${height} h${-width} Z`;
  }
  return [
    `M${x},${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    `L${x + width - r},${y}`,
    `A${r},${r} 0 0 1 ${x + width},${y + r}`,
    `L${x + width},${y + height}`,
    `L${x},${y + height}`,
    'Z',
  ].join(' ');
}

interface Tooltip {
  x: number;
  y: number;
  nickname: string;
  period: string;
  value: number;
  monthTotal: number;
}

function TrendsChart({ trends }: TrendsChartProps) {
  const [excludedCardIds, setExcludedCardIds] = useState<Set<string>>(
    new Set(),
  );
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

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

  const chartWidth = VIEWBOX_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const chartHeight = VIEWBOX_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const chartBottom = MARGIN_TOP + chartHeight;
  const slotWidth = chartWidth / trends.periods.length;
  const barWidth = slotWidth * BAR_WIDTH_RATIO;

  function yForValue(value: number): number {
    return (value / chartMax) * chartHeight;
  }

  function showTooltip(
    event: ReactPointerEvent | FocusEvent,
    nickname: string,
    period: string,
    value: number,
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
      monthTotal: monthTotals[periodIndex],
    });
  }

  const gridlines = Array.from({ length: GRIDLINE_COUNT + 1 }, (_, i) => {
    const value = (chartMax / GRIDLINE_COUNT) * i;
    return { value, y: chartBottom - yForValue(value) };
  });

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
          {trends.series.length >= 2 && (
            <div className="trends-legend">
              {trends.series.map((series, index) => (
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
            </div>
          )}

          <div className="trends-chart-scroll">
            <svg
              viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
              role="img"
              aria-label="Monthly spend by card, last 6 months"
            >
              {gridlines.map(({ value, y }) => (
                <g key={value}>
                  <line
                    x1={MARGIN_LEFT}
                    x2={VIEWBOX_WIDTH - MARGIN_RIGHT}
                    y1={y}
                    y2={y}
                    stroke="var(--border-color)"
                    strokeWidth={1}
                  />
                  <text
                    x={MARGIN_LEFT - 8}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize="0.75rem"
                    fill="var(--muted-color)"
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
                  MIN_SEGMENT_PX,
                  SEGMENT_GAP,
                );

                // Stack bottom-up: series[0] sits on the baseline, later
                // series stack above it with a SEGMENT_GAP between
                // adjacent nonzero segments. The topmost nonzero segment
                // gets the rounded top corner.
                const topIndex = (() => {
                  for (let i = visibleSeries.length - 1; i >= 0; i--) {
                    if (segmentHeights[i] > 0) return i;
                  }
                  return -1;
                })();

                let stackCursor = chartBottom; // y of the next segment's bottom edge
                const segments = visibleSeries.map((series, seriesIndex) => {
                  const value = series.values[periodIndex];
                  const height = segmentHeights[seriesIndex];
                  if (height <= 0) return null; // zero value: no mark, no gap

                  const top = stackCursor - height;
                  stackCursor = top - SEGMENT_GAP;

                  const originalIndex = trends.series.indexOf(series);
                  const color = colorVarFor(originalIndex, series);
                  const isTop = seriesIndex === topIndex;
                  const label = `${series.nickname} · ${period} · ${formatINR(value)}`;

                  return (
                    <path
                      key={series.cardId ?? 'other'}
                      className="trends-segment"
                      d={segmentPath(
                        barX,
                        top,
                        barWidth,
                        height,
                        isTop ? TOP_RADIUS : 0,
                      )}
                      fill={color}
                      tabIndex={0}
                      aria-label={label}
                      onPointerEnter={(e) =>
                        showTooltip(
                          e,
                          series.nickname,
                          period,
                          value,
                          periodIndex,
                        )
                      }
                      onPointerMove={(e) =>
                        showTooltip(
                          e,
                          series.nickname,
                          period,
                          value,
                          periodIndex,
                        )
                      }
                      onPointerLeave={() => setTooltip(null)}
                      onFocus={(e) =>
                        showTooltip(
                          e,
                          series.nickname,
                          period,
                          value,
                          periodIndex,
                        )
                      }
                      onBlur={() => setTooltip(null)}
                    />
                  );
                });

                const monthTotal = monthTotals[periodIndex];

                return (
                  <g key={period}>
                    {segments}
                    <text
                      x={slotX + slotWidth / 2}
                      y={chartBottom - yForValue(monthTotal) - 8}
                      textAnchor="middle"
                      fontSize="0.7rem"
                      fill="var(--muted-color)"
                    >
                      {monthTotal > 0 ? formatINRCompact(monthTotal) : ''}
                    </text>
                    <text
                      x={slotX + slotWidth / 2}
                      y={chartBottom + 16}
                      textAnchor="middle"
                      fontSize="0.75rem"
                      fill="var(--muted-color)"
                    >
                      {formatPeriodLabel(period)}
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
                {tooltip.nickname} · {formatPeriodLabel(tooltip.period)} ·{' '}
                <strong>{formatINR(tooltip.value)}</strong>
              </div>
              <div>Month total {formatINR(tooltip.monthTotal)}</div>
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
 * never gets a 9th generated hue — it's always var(--muted-color). */
function colorVarFor(index: number, series: TrendSeries): string {
  return series.cardId === null
    ? 'var(--muted-color)'
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
    <button
      type="button"
      className={dimmed ? 'legend-chip dimmed' : 'legend-chip'}
      onClick={onToggle}
      disabled={onToggle === undefined}
      aria-pressed={dimmed}
    >
      <span
        className="legend-swatch"
        style={{ background: colorVar }}
        aria-hidden="true"
      />
      {series.nickname}
    </button>
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
    <table className="txn-table">
      <thead>
        <tr>
          <th>Month</th>
          {trends.series.map((series) => (
            <th key={series.cardId ?? 'other'}>{series.nickname}</th>
          ))}
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {trends.periods.map((period, periodIndex) => (
          <tr key={period}>
            <td>{formatPeriodLabel(period)}</td>
            {trends.series.map((series) => (
              <td key={series.cardId ?? 'other'}>
                {formatINR(series.values[periodIndex])}
              </td>
            ))}
            <td>{formatINR(trends.monthTotals[periodIndex])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default TrendsChart;
