import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { useDataVersion } from '../context/DataVersionContext';
import { getStoredData } from '../db/db';
import type { StoredData } from '../db/schema';
import {
  buildInsights,
  HIGH_UTILISATION,
  RANGE_CHOICES,
  type CostKind,
  type Insights,
  type LabelledTxn,
  type RangeChoice,
} from '../lib/insights';
import { formatINR } from '../lib/money';
import { formatDateLabel, formatPeriodLabel, nextPeriod } from '../lib/dates';
import { plural } from '../lib/plural';
import { routeHash, type View } from '../lib/route';
import { useDocumentTitle } from './useDocumentTitle';

interface InsightsPageProps {
  /** Undefined: every card together. */
  cardId?: string;
  navigate: (view: View) => void;
}

const RANGE_LABELS: Record<RangeChoice, string> = {
  '3': 'Last 3 months',
  '12': 'Last 12 months',
  all: 'All',
};

/** Where the money went, what recurs and what the card costs, for one card
 * or all of them, over the last few bills. Everything is derived on the
 * spot from stored statements (lib/insights.ts); nothing here is saved. */
function InsightsPage({ cardId, navigate }: InsightsPageProps) {
  const db = useDb();
  const reportError = useReportError();
  const { version } = useDataVersion();
  const [data, setData] = useState<StoredData | null>(null);
  const [range, setRange] = useState<RangeChoice>('12');
  useDocumentTitle('Insights');

  useEffect(() => {
    let cancelled = false;
    getStoredData(db).then((loaded) => {
      if (!cancelled) setData(loaded);
    }, reportError);
    return () => {
      cancelled = true;
    };
  }, [db, version, reportError]);

  const insights = useMemo(
    () => (data === null ? null : buildInsights(data, range, cardId)),
    [data, range, cardId],
  );

  if (data === null) return <p role="status">Loading…</p>;

  if (data.cards.length === 0) {
    return (
      <div className="empty-state">
        <h1>Insights</h1>
        <p>
          Import your statements to see where your money goes, what repeats
          every month, and what your cards cost you.
        </p>
        <button
          className="primary"
          onClick={() => navigate({ name: 'import' })}
        >
          Import statements
        </button>
      </div>
    );
  }

  const cards = [...data.cards].sort((a, b) =>
    a.nickname.localeCompare(b.nickname),
  );
  const card =
    cardId === undefined ? undefined : cards.find((c) => c.id === cardId);
  const cardName = (id: string) =>
    cards.find((c) => c.id === id)?.nickname ?? 'Removed card';
  const showCard = cardId === undefined && cards.length > 1;

  const controls = (
    <div className="insights-controls">
      <div className="field">
        <label htmlFor="insights-card">Card</label>
        <select
          id="insights-card"
          value={card?.id ?? ''}
          onChange={(event) =>
            navigate({
              name: 'insights',
              cardId:
                event.target.value === '' ? undefined : event.target.value,
            })
          }
        >
          <option value="">All cards</option>
          {cards.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nickname}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="segmented">
        <legend>Months</legend>
        <div className="segmented-options">
          {RANGE_CHOICES.map((choice) => (
            <label key={choice}>
              <input
                type="radio"
                className="visually-hidden"
                name="insights-range"
                value={choice}
                checked={range === choice}
                onChange={() => setRange(choice)}
              />
              {RANGE_LABELS[choice]}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );

  if (cardId !== undefined && card === undefined) {
    return (
      <div className="insights-page">
        <h1>Insights</h1>
        <p>
          This card isn’t on this device any more.{' '}
          <a href={routeHash({ name: 'insights' })}>See all cards</a>
        </p>
      </div>
    );
  }

  return (
    <div className="insights-page">
      {card !== undefined && (
        <a
          className="back-link"
          href={routeHash({ name: 'card', cardId: card.id })}
        >
          <span aria-hidden="true">&larr;</span> Back to {card.nickname}
        </a>
      )}
      <h1>Insights</h1>
      {controls}
      {/* Mounted whatever is shown, so a change is always announced. */}
      <p className="muted insights-range" aria-live="polite">
        {insights === null ? '' : rangeLine(insights)}
      </p>
      {insights === null ? (
        <p className="muted">No statements for this card yet.</p>
      ) : (
        <InsightSections
          insights={insights}
          cardName={showCard ? cardName : null}
          singleCard={card !== undefined || cards.length === 1}
        />
      )}
    </div>
  );
}

function rangeLine(insights: Insights): string {
  const { from, to } = insights.range;
  const months =
    from === to
      ? formatPeriodLabel(to)
      : `${formatPeriodLabel(from)} to ${formatPeriodLabel(to)}`;
  return `${months}, from ${plural(insights.statementCount, 'statement')}.`;
}

function InsightSections({
  insights,
  cardName,
  singleCard,
}: {
  insights: Insights;
  /** Names a card in each row, when the page shows several. */
  cardName: ((id: string) => string) | null;
  singleCard: boolean;
}) {
  const {
    whereItWent: where,
    subscriptions,
    costs,
    credit,
    duplicates,
  } = insights;
  const costTotal = costs.charges;
  const noCharges = COST_ROWS.every(
    ([kind]) => kind === 'cashback' || costs.lines[kind].length === 0,
  );
  // Rows with lines first (they open), empty ones after, each in table order.
  const costRows = [
    ...COST_ROWS.filter(([kind]) => costs.lines[kind].length > 0),
    ...COST_ROWS.filter(([kind]) => costs.lines[kind].length === 0),
  ];
  const monthly = subscriptions.filter((s) => s.cadence === 'monthly');

  return (
    <>
      <section aria-labelledby="spend-heading">
        <h2 id="spend-heading">Spend breakdown</h2>
        {where.largest.length === 0 ? (
          <p className="muted">No purchases in these months.</p>
        ) : (
          <>
            <p className="insights-lead">
              <span className="amount">
                {formatINR(Math.max(0, where.total))}
              </span>{' '}
              spent, after refunds.
            </p>
            {where.merchants.length > 0 && (
              <>
                <h3 id="merchants-heading">Top merchants</h3>
                <div
                  className="cost-list"
                  role="group"
                  aria-labelledby="merchants-heading"
                >
                  {where.merchants.map((m) => (
                    <LinesRow
                      key={m.merchant}
                      label={m.merchant}
                      count={merchantCount(
                        m.purchases,
                        m.lines.length - m.purchases,
                      )}
                      figure={
                        <span className="amount">{formatINR(m.net)}</span>
                      }
                      lines={m.lines}
                      cardName={cardName}
                    >
                      <span className="share-bar" aria-hidden="true">
                        <span
                          style={{
                            width: `${Math.max(1, (m.net / where.merchants[0].net) * 100)}%`,
                          }}
                        />
                      </span>
                    </LinesRow>
                  ))}
                </div>
              </>
            )}
            <h3>Largest purchases</h3>
            <div className="table-scroll">
              <table className="txn-table" aria-label="Largest purchases">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Merchant</th>
                    {cardName && <th scope="col">Card</th>}
                    <th scope="col" className="num">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {where.largest.map((t) => (
                    <tr key={t.id}>
                      <td className="nowrap">{formatDateLabel(t.dateISO)}</td>
                      <td>{t.merchant}</td>
                      {cardName && <td>{cardName(t.cardId)}</td>}
                      <td className="num amount">{formatINR(-t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="subscriptions-heading">
        <h2 id="subscriptions-heading">Subscriptions</h2>
        {subscriptions.length === 0 ? (
          <p className="muted">
            No repeating charges found. A monthly charge shows here once it
            appears three months in a row; a yearly one, on its second year.
          </p>
        ) : (
          <>
            {monthly.length > 0 && (
              <p className="insights-lead">
                About{' '}
                <span className="amount">{formatINR(insights.committed)}</span>{' '}
                a month goes to {plural(monthly.length, 'monthly subscription')}
                .
              </p>
            )}
            <div className="table-scroll">
              <table className="txn-table" aria-label="Subscriptions">
                <thead>
                  <tr>
                    <th scope="col">Merchant</th>
                    <th scope="col">How often</th>
                    {cardName && <th scope="col">Card</th>}
                    <th scope="col" className="num">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((s) => (
                    <tr key={`${s.cardId}|${s.merchant}`}>
                      <td>{s.merchant}</td>
                      <td>
                        {s.cadence === 'monthly'
                          ? `Monthly since ${formatPeriodLabel(s.since)}`
                          : `Yearly, next around ${formatPeriodLabel(
                              addYear(s.lastPeriod),
                            )}`}
                      </td>
                      {cardName && <td>{cardName(s.cardId)}</td>}
                      <td className="num">
                        <span className="amount">{formatINR(s.amount)}</span>{' '}
                        {s.previousAmount !== undefined && (
                          <span className="price-rise">
                            Up from {formatINR(s.previousAmount)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="costs-heading">
        <h2 id="costs-heading">
          What {singleCard ? 'it costs' : 'your cards cost'}
        </h2>
        <p className="insights-lead">
          {costTotal > 0 && (
            <>
              <span className="amount">{formatINR(costTotal)}</span> in card
              charges, after waivers.
            </>
          )}
          {noCharges && 'No card charges in these months.'}
          {!noCharges &&
            costTotal <= 0 &&
            'More came back in waivers and reversals than was charged in these months.'}
        </p>
        <div className="cost-list">
          {costRows.map(([kind, label]) => (
            <CostRow
              key={kind}
              label={label}
              value={costs.amounts[kind]}
              lines={costs.lines[kind]}
              cardName={cardName}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="credit-heading">
        <h2 id="credit-heading">Credit used</h2>
        {credit.length === 0 ? (
          <p className="muted">
            The newest statements here don’t show both a total due and a credit
            limit.
          </p>
        ) : (
          <>
            <p className="section-note muted">
              Based on the latest imported statement
              {credit.length > 1 ? ' of each card' : ''}.
            </p>
            <ul className="credit-list">
              {credit.map((c) => (
                <li key={c.cardId}>
                  <div className="credit-head">
                    {cardName && (
                      <span className="credit-card">{cardName(c.cardId)}</span>
                    )}
                    <span
                      className="credit-pct"
                      data-high={high(c.ratio) || undefined}
                    >
                      {Math.round(c.ratio * 100)}%
                    </span>
                  </div>
                  <span
                    className="share-bar credit-bar"
                    aria-hidden="true"
                    data-high={high(c.ratio) || undefined}
                  >
                    <span
                      style={{ width: `${Math.min(100, c.ratio * 100)}%` }}
                    />
                  </span>
                  <p className="credit-detail muted">
                    {formatINR(Math.max(0, c.totalDue))} of{' '}
                    {formatINR(c.creditLimit)} limit
                  </p>
                </li>
              ))}
            </ul>
            {credit.some((c) => high(c.ratio)) && (
              <p className="section-note muted">
                Lenders often read more than{' '}
                {Math.round(HIGH_UTILISATION * 100)}% of a limit in use as
                stretched credit, which can weigh on a credit score.
              </p>
            )}
          </>
        )}
      </section>

      {duplicates.length > 0 && (
        <section aria-labelledby="duplicates-heading">
          <h2 id="duplicates-heading">Possible duplicates</h2>
          <p>Charged more than once on the same day, for the same amount.</p>
          <div className="table-scroll">
            <table className="txn-table" aria-label="Possible duplicates">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Merchant</th>
                  {cardName && <th scope="col">Card</th>}
                  <th scope="col" className="num">
                    Times
                  </th>
                  <th scope="col" className="num">
                    Each
                  </th>
                </tr>
              </thead>
              <tbody>
                {duplicates.map((d) => (
                  <tr
                    key={`${d.cardId}|${d.merchant}|${d.dateISO}|${d.amount}`}
                  >
                    <td className="nowrap">{formatDateLabel(d.dateISO)}</td>
                    <td>{d.merchant}</td>
                    {cardName && <td>{cardName(d.cardId)}</td>}
                    <td className="num">{d.count}</td>
                    <td className="num amount">{formatINR(d.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/** Every row's line list shows its waivers and reversals, so labels don't
 * need to say "after waivers". */
const COST_ROWS: [CostKind, string][] = [
  ['annualFee', 'Annual fee'],
  ['otherFees', 'Other fees'],
  ['gst', 'GST'],
  ['interest', 'Interest'],
  ['forexMarkup', 'Foreign currency markup'],
  ['cashback', 'Cashback earned'],
];

/** One cost figure; when lines are behind it, it opens to list them, so a
 * fee can be traced to the line that charged it. */
function CostRow({
  label,
  value,
  lines,
  cardName,
}: {
  label: string;
  /** Positive = cost; negative = money back (waivers, cashback). */
  value: number;
  lines: LabelledTxn[];
  cardName: ((id: string) => string) | null;
}) {
  const figure = <CostAmount value={value} />;
  if (lines.length === 0) {
    return (
      <div className="cost-row">
        <span>{label}</span>
        {figure}
      </div>
    );
  }
  return (
    <LinesRow
      label={label}
      count={plural(lines.length, 'line')}
      figure={figure}
      lines={lines}
      cardName={cardName}
    />
  );
}

/** A figure that opens to the statement lines behind it, as printed, so a
 * total can be checked line by line (a fee to the line that charged it, a
 * merchant's total to its purchases and refunds). Money out shows plain,
 * money back with a + in green. */
function LinesRow({
  label,
  count,
  figure,
  lines,
  cardName,
  children,
}: {
  label: string;
  count: string;
  figure: ReactNode;
  lines: LabelledTxn[];
  cardName: ((id: string) => string) | null;
  /** A full-width line under the row (a share bar). */
  children?: ReactNode;
}) {
  return (
    <details className="cost-row">
      <summary>
        <span>
          {label} <span className="muted cost-count">({count})</span>
        </span>
        {figure}
        {children}
      </summary>
      <div className="table-scroll">
        <table className="txn-table" aria-label={`${label}: lines`}>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">On the statement</th>
              {cardName && <th scope="col">Card</th>}
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((t) => (
              <tr key={t.id}>
                <td className="nowrap">{formatDateLabel(t.dateISO)}</td>
                <td>{t.payee}</td>
                {cardName && <td>{cardName(t.cardId)}</td>}
                <td className="num">
                  <CostAmount value={-t.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** "3 purchases", or "3 purchases, 1 refund" when refunds are among the
 * lines, so the count matches the list it opens to. */
function merchantCount(purchases: number, refunds: number): string {
  const count = plural(purchases, 'purchase');
  return refunds > 0 ? `${count}, ${plural(refunds, 'refund')}` : count;
}

/** Judged on the shown percentage, so "30%" never gets the "more than
 * 30%" note. */
function high(ratio: number): boolean {
  return Math.round(ratio * 100) > HIGH_UTILISATION * 100;
}

/** A cost: a charge plain, money back (a waiver, cashback) with a + and in
 * green, as on the statement pages. */
function CostAmount({ value }: { value: number }) {
  if (value < 0)
    return <span className="amount amount-credit">+{formatINR(-value)}</span>;
  return <span className="amount">{formatINR(value)}</span>;
}

function addYear(period: string): string {
  let p = period;
  for (let i = 0; i < 12; i++) p = nextPeriod(p);
  return p;
}

export default InsightsPage;
