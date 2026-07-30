import { useEffect, useState } from 'react';
import { useDb } from '../db/useDb';
import { useDataVersion } from '../context/DataVersionContext';
import {
  getAllCards,
  getActionableCycleByCard,
  getAllStatements,
  getAllCycles,
  setCyclePaid,
  putCard,
  deleteCardCascade,
} from '../db/db';
import type { CardRecord, CycleRecord } from '../db/schema';
import { sortDashboardCards, type CardWithCycle } from '../lib/sortCards';
import { unpaidSummary } from '../lib/unpaidSummary';
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
  const { version, bump } = useDataVersion();
  const [entries, setEntries] = useState<CardWithCycle[] | null>(null);
  const [trends, setTrends] = useState<MonthlyTrends | null>(null);
  const [statementCount, setStatementCount] = useState(0);

  useEffect(() => {
    if (db === null) return;
    let cancelled = false;

    (async () => {
      const cards = await getAllCards(db);
      const withCycles = await Promise.all(
        cards.map(async (card) => ({
          card,
          cycle: await getActionableCycleByCard(db, card.id),
        })),
      );
      const [statements, cycles] = await Promise.all([
        getAllStatements(db),
        getAllCycles(db),
      ]);
      if (cancelled) return;
      setEntries(withCycles);
      setStatementCount(statements.length);
      // cycle.spend is the single source of truth for what a cycle cost
      // (recomputed by db.ts's recomputeCardSpends on every commit) — the
      // chart reads it straight from the stored cycles rather than
      // re-deriving it from transactions, so it can never disagree with
      // what CardDetail's statement rows or this dashboard's own tiles show.
      setTrends(monthlyTrends(cards, cycles));
    })();

    return () => {
      cancelled = true;
    };
  }, [db, version]);

  async function handleTogglePaid(cardId: string, cycle: CycleRecord) {
    if (db === null) return;
    // Toggle: an already-paid cycle un-pays (paidAt -> null); an unpaid
    // one is marked paid as of today.
    const nextPaidAt = cycle.paidAt === undefined ? todayISO() : null;
    await setCyclePaid(db, cardId, cycle.period, nextPaidAt);
    bump();
  }

  async function handleRename(card: CardRecord, nickname: string) {
    if (db === null) return;
    await putCard(db, { ...card, nickname });
    bump();
  }

  async function handleDelete(cardId: string) {
    if (db === null) return;
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
              if (cycle !== null) void handleTogglePaid(card.id, cycle);
            }}
            onRename={(nickname) => void handleRename(card, nickname)}
            onDelete={() => void handleDelete(card.id)}
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
