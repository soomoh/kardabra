import type {
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../db/schema';
import { formatINR } from '../lib/money';
import { billUnderpaid, priorExpectedDue, sumOfCredits } from '../lib/spend';
import { chargeTotals } from '../lib/charges';
import { formatDateLabel, formatPeriodLabel } from '../lib/dates';

interface StatementListProps {
  /** Newest first. */
  statements: StatementRecord[];
  transactions: TransactionRecord[];
  cyclesByPeriod: Map<string, CycleRecord>;
  selectedId: string | null;
  onSelect: (statementId: string) => void;
}

/** One row per imported statement: spend (cycle.spend), due date, and the
 * soft warnings — interest already billed, last bill not fully paid. */
function StatementList({
  statements,
  transactions,
  cyclesByPeriod,
  selectedId,
  onSelect,
}: StatementListProps) {
  return (
    <section>
      <h2>Statements</h2>
      {statements.length === 0 ? (
        <p>No statements imported yet.</p>
      ) : (
        <ul className="statement-list">
          {statements.map((statement, index) => {
            const stmtTxns = transactions.filter(
              (txn) => txn.statementId === statement.id,
            );
            const charges = chargeTotals(stmtTxns);
            const interestAndLate = charges.interest + charges.late;
            const spend = cyclesByPeriod.get(statement.period)?.spend ?? 0;
            // Did this statement's credits (payment plus refunds) cover the
            // prior statement's due? If not, interest may follow.
            const priorStatement = statements[index + 1];
            const underpaid = billUnderpaid(
              sumOfCredits(stmtTxns),
              priorExpectedDue(
                priorStatement,
                priorStatement && cyclesByPeriod.get(priorStatement.period),
              ),
            );
            // Any older statement's total was rolled into a newer one
            // (lib/cycles.ts), so its due date is no longer a deadline.
            const settled = index > 0;
            return (
              <li key={statement.id}>
                <button
                  className={
                    statement.id === selectedId
                      ? 'statement-row selected'
                      : 'statement-row'
                  }
                  onClick={() => onSelect(statement.id)}
                >
                  <span className="statement-period">
                    {formatPeriodLabel(statement.period)}
                  </span>
                  <span>{statement.fileName}</span>
                  <span>{statement.txnCount} txns</span>
                  <span className="amount">Spend {formatINR(spend)}</span>
                  {interestAndLate > 0 && (
                    <span className="charge-hint">
                      includes {formatINR(interestAndLate)} interest/late
                      charges
                    </span>
                  )}
                  {underpaid && (
                    <span className="charge-hint">
                      payment didn&apos;t cover last month&apos;s bill —
                      interest may apply
                    </span>
                  )}
                  {settled ? (
                    <span className="badge">settled by later statement</span>
                  ) : (
                    statement.dueDateISO !== undefined && (
                      <span>Due {formatDateLabel(statement.dueDateISO)}</span>
                    )
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default StatementList;
