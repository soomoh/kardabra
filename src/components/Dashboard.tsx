import { useEffect, useRef, useState } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { useDataVersion } from '../context/DataVersionContext';
import {
  getAllCards,
  getAllStatements,
  getAllCycles,
  getAllTransactions,
  setCyclePaid,
  putCard,
  deleteCardCascade,
} from '../db/db';
import type { CardRecord, CycleRecord } from '../db/schema';
import { sortDashboardCards, type CardWithCycle } from '../lib/sortCards';
import { unpaidTotals } from '../lib/unpaidSummary';
import { actionableCycle, cycleNeedsPayment } from '../lib/cycles';
import { formatDateLabel, todayISO } from '../lib/dates';
import { formatINR } from '../lib/money';
import { cycleKey, monthlyTrends, type MonthlyTrends } from '../lib/trends';
import { statementsToCheckByCard } from '../lib/reconcile';
import { billsIn, billsInCopy, type BillsIn } from '../lib/billsIn';
import CardTile from './CardTile';
import SettledCardRow from './SettledCardRow';
import TrendsChart from './TrendsChart';
import { useDocumentTitle } from './useDocumentTitle';
import { XIcon } from './icons';
import { routeHash, type View } from '../lib/route';

interface DashboardProps {
  navigate: (view: View, options?: { replace?: boolean }) => void;
  /** Shown once on arrival, e.g. what an import just did. */
  notice?: string;
}

// A bar appears from the very first import — one month of data is still
// data. Requiring two points before showing anything would leave an
// empty gap where the chart belongs, which reads as a bug, not restraint.
const MIN_STATEMENTS_FOR_TRENDS = 1;

function Dashboard({ navigate, notice }: DashboardProps) {
  const db = useDb();
  const reportError = useReportError();
  const { version, bump } = useDataVersion();
  const [entries, setEntries] = useState<CardWithCycle[] | null>(null);
  const [trends, setTrends] = useState<MonthlyTrends | null>(null);
  const [statementCount, setStatementCount] = useState(0);
  const [toCheck, setToCheck] = useState<Map<string, number>>(new Map());
  // Computed with the day it was loaded on, so its words and numbers agree.
  const [bills, setBills] = useState<{ result: BillsIn; today: string } | null>(
    null,
  );
  useDocumentTitle('Dashboard');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [cards, statements, cycles, transactions] = await Promise.all([
        getAllCards(db),
        getAllStatements(db),
        getAllCycles(db),
        getAllTransactions(db),
      ]);
      if (cancelled) return;
      const loaded = cards.map((card) => ({
        card,
        cycle: actionableCycle(cycles.filter((c) => c.cardId === card.id)),
      }));
      // Only a card's actionable cycle can be unpaid; older ones were
      // rolled into it (lib/cycles.ts).
      const unpaidKeys = new Set(
        loaded.flatMap(({ card, cycle }) =>
          cycle !== null && cycleNeedsPayment(cycle)
            ? [cycleKey(card.id, cycle.period)]
            : [],
        ),
      );
      setEntries(loaded);
      setStatementCount(statements.length);
      setToCheck(statementsToCheckByCard(statements, transactions));
      setTrends(monthlyTrends(cards, cycles, unpaidKeys));
      const today = todayISO();
      setBills({ result: billsIn(cards, statements, cycles, today), today });
    })().catch(reportError);

    return () => {
      cancelled = true;
    };
  }, [db, version, reportError]);

  // Cards with a paid/unpaid write in flight: a double click must not
  // toggle twice (paid, then straight back to unpaid).
  const toggling = useRef(new Set<string>());
  // Paying moves a card between a tile and a settled row, unmounting the
  // focused button: once the reload renders, focus that card's new one.
  const focusCardAction = useRef<string | null>(null);
  useEffect(() => {
    const cardId = focusCardAction.current;
    if (cardId === null || entries === null) return;
    focusCardAction.current = null;
    // An undone ₹0 bill keeps no button: keep focus on the page, not <body>.
    const target =
      document.querySelector<HTMLElement>(
        `[data-card-action="${CSS.escape(cardId)}"]`,
      ) ?? document.querySelector<HTMLElement>('main');
    target?.focus();
  }, [entries]);

  async function handleTogglePaid(cardId: string, cycle: CycleRecord) {
    if (toggling.current.has(cardId)) return;
    toggling.current.add(cardId);
    try {
      await togglePaid(cardId, cycle);
    } finally {
      toggling.current.delete(cardId);
    }
  }

  async function togglePaid(cardId: string, cycle: CycleRecord) {
    // Toggle: an already-paid cycle un-pays (paidAt -> null); an unpaid
    // one is marked paid as of today.
    const nextPaidAt = cycle.paidAt === undefined ? todayISO() : null;
    await setCyclePaid(db, cardId, cycle.period, nextPaidAt);
    focusCardAction.current = cardId;
    bump();
  }

  async function handleRename(card: CardRecord, nickname: string) {
    await putCard(db, { ...card, nickname });
    bump();
  }

  async function handleDelete(cardId: string) {
    await deleteCardCascade(db, cardId);
    bump();
  }

  if (entries === null) {
    return <p role="status">Loading…</p>;
  }

  if (entries.length === 0) {
    return (
      <div className="empty-state">
        <h1>No cards yet</h1>
        <p>
          Import your credit-card statements to see what you owe, when it's due,
          and where the money went. Everything stays on this device.
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

  const sorted = sortDashboardCards(entries);
  // Settled cards (paid, or nothing owed) step back into a compact list;
  // a card returns to a full tile once a statement with a bill comes in.
  const tiles = sorted.filter(
    ({ cycle }) => cycle === null || cycleNeedsPayment(cycle),
  );
  const settled = sorted.flatMap(({ card, cycle }) =>
    cycle !== null && !cycleNeedsPayment(cycle) ? [{ card, cycle }] : [],
  );
  // Most urgent first, so the first card that needs paying holds the
  // page's one primary action.
  const primaryCardId = sorted.find(
    ({ cycle }) => cycle !== null && cycleNeedsPayment(cycle),
  )?.card.id;

  return (
    <div>
      {notice !== undefined && (
        <div className="notice" role="status">
          <p>{notice}</p>
          <button
            className="icon-button"
            aria-label="Dismiss"
            onClick={() => {
              navigate({ name: 'dashboard' });
              // The button disappears; keep focus on the page, not <body>.
              document.querySelector<HTMLElement>('main')?.focus();
            }}
          >
            <XIcon />
          </button>
        </div>
      )}
      {bills !== null && (
        <Headline entries={entries} bills={bills.result} today={bills.today} />
      )}

      {tiles.length > 0 && (
        <div className="card-grid">
          {tiles.map(({ card, cycle }) => (
            <CardTile
              key={card.id}
              card={card}
              cycle={cycle}
              statementsToCheck={toCheck.get(card.id) ?? 0}
              primary={card.id === primaryCardId}
              onTogglePaid={() => {
                if (cycle !== null)
                  void handleTogglePaid(card.id, cycle).catch(reportError);
              }}
              onRename={(nickname) =>
                void handleRename(card, nickname).catch(reportError)
              }
              onDelete={() => void handleDelete(card.id).catch(reportError)}
            />
          ))}
        </div>
      )}

      {settled.length > 0 && (
        <section className="settled" aria-labelledby="settled-heading">
          <h2 id="settled-heading" className="settled-heading">
            Nothing to pay
          </h2>
          <ul className="settled-list">
            {settled.map(({ card, cycle }) => (
              <SettledCardRow
                key={card.id}
                card={card}
                cycle={cycle}
                statementsToCheck={toCheck.get(card.id) ?? 0}
                onTogglePaid={() =>
                  void handleTogglePaid(card.id, cycle).catch(reportError)
                }
              />
            ))}
          </ul>
        </section>
      )}

      {statementCount >= MIN_STATEMENTS_FOR_TRENDS && trends !== null && (
        <TrendsChart trends={trends} />
      )}
    </div>
  );
}

/** What you owe across all cards, and by when: the dashboard's headline.
 * Paise are drawn smaller so the rupees read first. */
function Headline({
  entries,
  bills,
  today,
}: {
  entries: CardWithCycle[];
  bills: BillsIn;
  today: string;
}) {
  const { count, total, isEstimate } = unpaidTotals(entries);
  const copy = billsInCopy(bills, today);
  // Separate lines, not one paragraph: each is its own update.
  const facts = (copy.payment !== null || copy.count !== null) && (
    <ul className="hero-facts">
      {copy.payment !== null && (
        <li>
          {copy.payment.prefix}{' '}
          <strong>{formatDateLabel(copy.payment.dateISO, today)}</strong>
        </li>
      )}
      {copy.count !== null && <li>{copy.count}</li>}
    </ul>
  );
  const notes = copy.nudges.length > 0 && (
    <ul className="hero-notes">
      {copy.nudges.map((nudge, index) => (
        // Nudges can repeat (two cards may share a nickname); order is stable.
        <li key={index}>
          {nudge.text}
          {nudge.importCard !== undefined && (
            <>
              {' '}
              <a
                className="hero-link"
                href={routeHash({ name: 'import' })}
                // Visible words first, so voice control can say them.
                aria-label={`Import it, ${nudge.importCard}'s statement`}
              >
                Import it
              </a>
            </>
          )}
        </li>
      ))}
    </ul>
  );
  if (count === 0) {
    return (
      <header className="dashboard-header">
        <h1 className="hero-amount">All caught up</h1>
        {facts || <p className="hero-sub">No unpaid bills on any card.</p>}
        {notes}
      </header>
    );
  }
  const formatted = total === null ? null : formatINR(total);
  const dot = formatted?.lastIndexOf('.') ?? -1;
  return (
    <header className="dashboard-header">
      {/* The label is part of the heading, so heading navigation reads
          "To pay ₹9,500.00", not a bare amount. */}
      <h1 className="hero-heading">
        <span className="hero-label">
          {isEstimate ? 'To pay, about' : 'To pay'}
        </span>
        <span className="hero-amount amount">
          {formatted === null ? (
            `${count} unpaid`
          ) : dot === -1 ? (
            formatted
          ) : (
            <>
              {formatted.slice(0, dot)}
              <span className="paise">{formatted.slice(dot)}</span>
            </>
          )}
        </span>
      </h1>
      {facts}
      {notes}
    </header>
  );
}

export default Dashboard;
