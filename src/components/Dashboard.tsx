import { useEffect, useState } from 'react';
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
import CardTile from './CardTile';
import TrendsChart from './TrendsChart';
import { useDocumentTitle } from './useDocumentTitle';
import { XIcon } from './icons';
import type { View } from '../App';

interface DashboardProps {
  setView: (view: View) => void;
  /** Shown once on arrival, e.g. what an import just did. */
  notice?: string;
}

// A bar appears from the very first import — one month of data is still
// data. Requiring two points before showing anything would leave an
// empty gap where the chart belongs, which reads as a bug, not restraint.
const MIN_STATEMENTS_FOR_TRENDS = 1;

function Dashboard({ setView, notice }: DashboardProps) {
  const db = useDb();
  const reportError = useReportError();
  const { version, bump } = useDataVersion();
  const [entries, setEntries] = useState<CardWithCycle[] | null>(null);
  const [trends, setTrends] = useState<MonthlyTrends | null>(null);
  const [statementCount, setStatementCount] = useState(0);
  const [toCheck, setToCheck] = useState<Map<string, number>>(new Map());
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
    })().catch(reportError);

    return () => {
      cancelled = true;
    };
  }, [db, version, reportError]);

  async function handleTogglePaid(cardId: string, cycle: CycleRecord) {
    // Toggle: an already-paid cycle un-pays (paidAt -> null); an unpaid
    // one is marked paid as of today.
    const nextPaidAt = cycle.paidAt === undefined ? todayISO() : null;
    await setCyclePaid(db, cardId, cycle.period, nextPaidAt);
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
        <button className="primary" onClick={() => setView({ name: 'import' })}>
          Import statements
        </button>
      </div>
    );
  }

  const sorted = sortDashboardCards(entries);

  return (
    <div>
      {notice !== undefined && (
        <div className="notice" role="status">
          <p>{notice}</p>
          <button
            className="icon-button"
            aria-label="Dismiss"
            onClick={() => {
              setView({ name: 'dashboard' });
              // The button disappears; keep focus on the page, not <body>.
              document.querySelector<HTMLElement>('main')?.focus();
            }}
          >
            <XIcon />
          </button>
        </div>
      )}
      <Headline entries={entries} />

      <div className="card-grid">
        {sorted.map(({ card, cycle }) => (
          <CardTile
            key={card.id}
            card={card}
            cycle={cycle}
            statementsToCheck={toCheck.get(card.id) ?? 0}
            onOpen={() => setView({ name: 'card', cardId: card.id })}
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

      {statementCount >= MIN_STATEMENTS_FOR_TRENDS && trends !== null && (
        <TrendsChart trends={trends} />
      )}
    </div>
  );
}

/** What you owe across all cards, and by when: the dashboard's headline.
 * Paise are drawn smaller so the rupees read first. */
function Headline({ entries }: { entries: CardWithCycle[] }) {
  const { count, total, isEstimate, nextDueISO } = unpaidTotals(entries);
  if (count === 0) {
    return (
      <header className="dashboard-header">
        <h1 className="hero-amount">All caught up</h1>
        <p className="hero-sub">No unpaid bills on any card.</p>
      </header>
    );
  }
  const formatted = total === null ? null : formatINR(total);
  const dot = formatted?.lastIndexOf('.') ?? -1;
  const bills = count === 1 ? '1 card' : `${count} cards`;
  return (
    <header className="dashboard-header">
      <p className="hero-label">{isEstimate ? 'To pay, about' : 'To pay'}</p>
      <h1 className="hero-amount amount">
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
      </h1>
      <p className="hero-sub">
        across {bills}
        {nextDueISO !== null && (
          <>
            {' '}
            · next bill due <strong>{formatDateLabel(nextDueISO)}</strong>
          </>
        )}
      </p>
    </header>
  );
}

export default Dashboard;
