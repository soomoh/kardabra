import type {
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../db/schema';
import { formatINR } from '../lib/money';
import { billUnderpaid, priorExpectedDue, sumOfCredits } from '../lib/spend';
import { chargeTotals } from '../lib/charges';
import { olderBillStatus, type OlderBillStatus } from '../lib/olderBill';
import { statementNeedsCheck } from '../lib/reconcile';
import { Fragment } from 'react';
import {
  formatDateLabel,
  formatPeriodLabel,
  periodsBetween,
} from '../lib/dates';

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
            const cycle = cyclesByPeriod.get(statement.period);
            const spend = cycle?.spend ?? 0;
            // The cycle's due date: printed, or projected from the card's
            // due day when the statement prints none (lib/dates.ts).
            const dueDateISO = cycle?.dueDateISO ?? statement.dueDateISO;
            // Did this statement's credits (payment plus refunds) cover the
            // prior statement's due? If not, interest may follow.
            const priorStatement = statements[index + 1];
            const underpaid = billUnderpaid(
              sumOfCredits(stmtTxns),
              priorExpectedDue(
                statement.period,
                priorStatement,
                priorStatement && cyclesByPeriod.get(priorStatement.period),
              ),
            );
            // Any older statement's due date is no longer a deadline (the
            // newest total is what's owed); what's said about its payment
            // comes only from what the statements show (lib/olderBill.ts).
            const newer = statements[index - 1];
            const older =
              newer === undefined
                ? null
                : olderBillStatus(statement, cycle, {
                    period: newer.period,
                    credits: sumOfCredits(
                      transactions.filter((t) => t.statementId === newer.id),
                    ),
                  });
            // Months with no statement between this one and the next older:
            // named, so a gap is never silent (newest first, like the list).
            const missing = priorStatement
              ? periodsBetween(
                  priorStatement.period,
                  statement.period,
                ).reverse()
              : [];
            return (
              <Fragment key={statement.id}>
                <li>
                  <button
                    className={
                      statement.id === selectedId
                        ? 'statement-row selected'
                        : 'statement-row'
                    }
                    aria-current={
                      statement.id === selectedId ? 'true' : undefined
                    }
                    onClick={() => onSelect(statement.id)}
                  >
                    <span className="statement-period">
                      {formatPeriodLabel(statement.period)}
                    </span>
                    {statementNeedsCheck(
                      statement,
                      stmtTxns,
                      statement.skippedRows ?? 0,
                    ) && (
                      <span className="badge badge-attention">
                        Check totals
                      </span>
                    )}
                    <span className="muted">{statement.fileName}</span>
                    <span>
                      {statement.txnCount}{' '}
                      {statement.txnCount === 1
                        ? 'transaction'
                        : 'transactions'}
                    </span>
                    <span className="amount">Spent {formatINR(spend)}</span>
                    {interestAndLate > 0 && (
                      <span className="charge-hint">
                        Includes {formatINR(interestAndLate)} in interest and
                        late fees
                      </span>
                    )}
                    {underpaid && (
                      <span className="charge-hint">
                        Payment didn&apos;t cover last month&apos;s bill, so
                        interest may apply
                      </span>
                    )}
                    {older !== null ? (
                      <OlderBillBadge status={older} />
                    ) : (
                      dueDateISO != null && (
                        <span className="statement-due">
                          Due {formatDateLabel(dueDateISO)}
                        </span>
                      )
                    )}
                  </button>
                </li>
                {missing.map((period) => (
                  <li key={period} className="statement-gap">
                    {formatPeriodLabel(period)}: no statement imported
                  </li>
                ))}
              </Fragment>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** An older bill's payment, in words that claim no more than is known. */
function OlderBillBadge({ status }: { status: OlderBillStatus }) {
  switch (status.kind) {
    case 'marked-paid':
      return <span className="badge">Marked paid</span>;
    case 'covered':
      return (
        <span className="badge">
          Covered in the {formatPeriodLabel(status.by)} statement
        </span>
      );
    case 'not-covered':
      return (
        <span className="badge badge-attention">
          Not fully covered in the {formatPeriodLabel(status.by)} statement
        </span>
      );
    case 'unknown':
      return (
        <span className="badge">
          Payment unknown: no {formatPeriodLabel(status.missing)} statement
        </span>
      );
    case 'nothing-due':
      return <span className="badge">Nothing was due</span>;
    case 'no-amount':
      return <span className="badge">Payment unknown: no bill amount</span>;
  }
}

export default StatementList;
