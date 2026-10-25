import { useEffect, useState } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { useDataVersion } from '../context/DataVersionContext';
import {
  getAllCards,
  getAllStatements,
  getAllCycles,
  setCyclePaid,
  putCard,
  deleteCardCascade,
} from '../db/db';
import type { CardRecord, CycleRecord } from '../db/schema';
import { sortDashboardCards, type CardWithCycle } from '../lib/sortCards';
import { unpaidSummary } from '../lib/unpaidSummary';
import { actionableCycle } from '../lib/cycles';
import { todayISO } from '../lib/dates';
import { monthlyTrends, type MonthlyTrends } from '../lib/trends';
import CardTile from './CardTile';
import TrendsChart from './TrendsChart';
import type { View } from '../App';

interface DashboardProps {
  setView: (view: View) => void;
}

// A bar appears from the very first import — one month of data is still
// data. Requiring two points before showing anything would leave an
// empty gap where the chart belongs, which reads as a bug, not restraint.
const MIN_STATEMENTS_FOR_TRENDS = 1;

function Dashboard({ setView }: DashboardProps) {
  const db = useDb();
  const reportError = useReportError();
  const { version, bump } = useDataVersion();
  const [entries, setEntries] = useState<CardWithCycle[] | null>(null);
  const [trends, setTrends] = useState<MonthlyTrends | null>(null);
  const [statementCount, setStatementCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [cards, statements, cycles] = await Promise.all([
        getAllCards(db),
        getAllStatements(db),
        getAllCycles(db),
      ]);
      if (cancelled) return;
      setEntries(
        cards.map((card) => ({
          card,
          cycle: actionableCycle(cycles.filter((c) => c.cardId === card.id)),
        })),
      );
      setStatementCount(statements.length);
      setTrends(monthlyTrends(cards, cycles));
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
    return <p>Loading…</p>;
  }

  if (entries.length === 0) {
    return (
      <div className="empty-state">
        <h1>Kardabra</h1>
        <p>No cards yet. Import a statement to get started.</p>
        <button onClick={() => setView({ name: 'import' })}>
          Import statements
        </button>
      </div>
    );
  }

  const sorted = sortDashboardCards(entries);

  return (
    <div>
      {/* No "Kardabra" heading here — the name already lives in the nav
          bar, so a second copy above the total would be pure redundancy.
          The unpaid summary IS the dashboard's headline. */}
      <header className="dashboard-header">
        <p className="dashboard-summary">{unpaidSummary(entries)}</p>
      </header>

      <div className="card-grid">
        {sorted.map(({ card, cycle }) => (
          <CardTile
            key={card.id}
            card={card}
            cycle={cycle}
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

export default Dashboard;
