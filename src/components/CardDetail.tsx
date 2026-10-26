import { useEffect, useState } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { useDataVersion } from '../context/DataVersionContext';
import {
  getCard,
  getStatementsForCard,
  getTransactionsForCard,
  getCyclesForCard,
  putCard,
  deleteCardCascade,
  setPaymentOverride,
} from '../db/db';
import type {
  CardRecord,
  StatementRecord,
  TransactionRecord,
  CycleRecord,
} from '../db/schema';
import { priorExpectedDue, type PaymentMark } from '../lib/spend';
import { annualFeeNet } from '../lib/charges';
import { todayISO } from '../lib/dates';
import CardHeader from './CardHeader';
import StatementList from './StatementList';
import StatementTransactions from './StatementTransactions';
import type { View } from '../App';
import { useDocumentTitle } from './useDocumentTitle';

interface CardDetailProps {
  cardId: string;
  setView: (view: View) => void;
}

function CardDetail({ cardId, setView }: CardDetailProps) {
  const db = useDb();
  const reportError = useReportError();
  const { version, bump } = useDataVersion();
  const [card, setCard] = useState<CardRecord | null>(null);
  const [statements, setStatements] = useState<StatementRecord[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [cycles, setCycles] = useState<CycleRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The card was deleted (another tab) or the id is stale.
  const [missing, setMissing] = useState(false);
  useDocumentTitle(missing ? 'Card not found' : (card?.nickname ?? null));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [loadedCard, loadedStatements, loadedTransactions, loadedCycles] =
        await Promise.all([
          getCard(db, cardId),
          getStatementsForCard(db, cardId), // newest first
          getTransactionsForCard(db, cardId),
          getCyclesForCard(db, cardId),
        ]);
      if (cancelled) return;
      setCard(loadedCard ?? null);
      setMissing(loadedCard === undefined);
      setStatements(loadedStatements);
      setTransactions(loadedTransactions);
      setCycles(loadedCycles);
      // Keep the selection across a refresh while that statement still
      // exists; otherwise select the newest.
      setSelectedId((current) =>
        current !== null && loadedStatements.some((s) => s.id === current)
          ? current
          : (loadedStatements[0]?.id ?? null),
      );
    })().catch(reportError);
    return () => {
      cancelled = true;
    };
  }, [db, cardId, version, reportError]);

  const backLink = (
    <button
      className="back-link"
      onClick={() => setView({ name: 'dashboard' })}
    >
      &larr; Back to dashboard
    </button>
  );

  if (missing) {
    return (
      <div>
        {backLink}
        <p>This card isn't on this device any more.</p>
      </div>
    );
  }
  if (card === null) {
    return (
      <div>
        {backLink}
        <p role="status">Loading…</p>
      </div>
    );
  }

  // Spend is read from cycles, never recomputed here (schema.ts).
  const cyclesByPeriod = new Map(cycles.map((c) => [c.period, c]));
  const selectedIndex = statements.findIndex((s) => s.id === selectedId);
  const selected = statements[selectedIndex] as StatementRecord | undefined;
  const prior = selected && statements[selectedIndex + 1]; // newest first

  async function saveCard(updated: CardRecord) {
    await putCard(db, updated);
    bump();
  }

  async function deleteCard() {
    await deleteCardCascade(db, cardId);
    bump();
    setView({ name: 'dashboard' });
  }

  async function savePaymentOverride(marks: PaymentMark[] | undefined) {
    if (selected === undefined) return;
    await setPaymentOverride(db, cardId, selected.period, marks);
    bump();
  }

  return (
    <div>
      {backLink}
      <CardHeader
        card={card}
        statementCount={statements.length}
        transactionCount={transactions.length}
        feeNet={annualFeeNet(transactions, todayISO())}
        onSave={saveCard}
        onDelete={deleteCard}
      />
      <StatementList
        statements={statements}
        transactions={transactions}
        cyclesByPeriod={cyclesByPeriod}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      {selected !== undefined && (
        <StatementTransactions
          key={selected.id}
          statement={selected}
          transactions={transactions
            .filter((txn) => txn.statementId === selected.id)
            .sort((a, b) => a.dateISO.localeCompare(b.dateISO))}
          cycle={cyclesByPeriod.get(selected.period)}
          priorExpectedDue={priorExpectedDue(
            prior,
            prior && cyclesByPeriod.get(prior.period),
          )}
          onSetPaymentOverride={savePaymentOverride}
        />
      )}
    </div>
  );
}

export default CardDetail;
