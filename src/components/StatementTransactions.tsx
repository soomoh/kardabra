import { useState } from 'react';
import { useReportError } from '../db/DbProvider';
import TotalsWarning from './TotalsWarning';
import type {
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../db/schema';
import { formatSignedINR } from '../lib/money';
import { identifyPaymentIndices, type PaymentMark } from '../lib/spend';
import { formatDateLabel } from '../lib/dates';

/** "Which rows are checked" exists only while selecting. `checked` holds
 * positions in this statement's sorted transaction list. */
type FixMode = { mode: 'view' } | { mode: 'selecting'; checked: Set<number> };

interface StatementTransactionsProps {
  statement: StatementRecord;
  /** This statement's transactions, oldest first. */
  transactions: TransactionRecord[];
  cycle: CycleRecord | undefined;
  priorExpectedDue: number | null;
  /** Save the user's payment rows; undefined returns to auto-detection. */
  onSetPaymentOverride: (marks: PaymentMark[] | undefined) => Promise<void>;
}

/**
 * One statement's transactions, with the identified bill payment labelled
 * and the "Fix bill payment" flow. The parent keys this by statement, so
 * switching statements always drops a half-made selection rather than
 * applying it to the wrong one.
 */
function StatementTransactions({
  statement,
  transactions,
  cycle,
  priorExpectedDue,
  onSetPaymentOverride,
}: StatementTransactionsProps) {
  const reportError = useReportError();
  const [fixMode, setFixMode] = useState<FixMode>({ mode: 'view' });

  // The payment SET (lib/spend.ts) — possibly several rows, possibly none.
  // It drives both the "· bill payment" labels and the Fix flow's
  // pre-checked boxes, so the two always agree.
  const paymentIndices = identifyPaymentIndices(transactions, {
    priorExpectedDue,
    override: cycle?.paymentOverride,
  });

  function toggleChecked(index: number) {
    setFixMode((current) => {
      if (current.mode !== 'selecting') return current;
      const next = new Set(current.checked);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return { mode: 'selecting', checked: next };
    });
  }

  async function saveOverride() {
    if (fixMode.mode !== 'selecting') return;
    // By value, not index: a re-import recreates these rows (PaymentMark).
    await onSetPaymentOverride(
      [...fixMode.checked].map((index) => ({
        amount: transactions[index].amount,
        payee: transactions[index].payee,
      })),
    );
    setFixMode({ mode: 'view' });
  }

  async function resetOverride() {
    await onSetPaymentOverride(undefined);
    setFixMode({ mode: 'view' });
  }

  const selecting = fixMode.mode === 'selecting';
  return (
    <section>
      <TotalsWarning
        summary={statement}
        transactions={transactions}
        skippedRows={statement.skippedRows ?? 0}
      />
      <div className="txn-header">
        <h2>Transactions</h2>
        {/* One button for the statement, not per row: a payment can be
            several rows (a split payment). */}
        {fixMode.mode === 'view' ? (
          <div className="import-actions">
            <button
              onClick={() =>
                setFixMode({
                  mode: 'selecting',
                  checked: new Set(paymentIndices),
                })
              }
            >
              Fix bill payment
            </button>
            {cycle?.paymentOverride !== undefined && (
              <button onClick={() => void resetOverride().catch(reportError)}>
                Reset to automatic
              </button>
            )}
          </div>
        ) : (
          <div className="import-actions">
            <button onClick={() => void saveOverride().catch(reportError)}>
              Save
            </button>
            <button onClick={() => setFixMode({ mode: 'view' })}>Cancel</button>
          </div>
        )}
      </div>
      <table className="txn-table">
        <thead>
          <tr>
            {selecting && <th></th>}
            <th>Date</th>
            <th>Payee</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((txn, index) => (
            // Rows have no stable id of their own; position is part of the
            // key, matching the Fix flow's `checked` positions.
            <tr key={`${txn.dateISO}-${txn.payee}-${txn.amount}-${index}`}>
              {fixMode.mode === 'selecting' && (
                <td>
                  <input
                    type="checkbox"
                    checked={fixMode.checked.has(index)}
                    onChange={() => toggleChecked(index)}
                    aria-label={`Mark ${txn.payee} as bill payment`}
                  />
                </td>
              )}
              <td>{formatDateLabel(txn.dateISO)}</td>
              <td>
                {txn.payee}
                {!selecting && paymentIndices.includes(index) && (
                  <span className="credit-label"> · bill payment</span>
                )}
              </td>
              <td className={txn.amount < 0 ? 'amount-debit' : 'amount-credit'}>
                {formatSignedINR(txn.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default StatementTransactions;
