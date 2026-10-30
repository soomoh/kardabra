import { useEffect, useRef, useState } from 'react';
import { useReportError } from '../db/DbProvider';
import TotalsWarning from './TotalsWarning';
import { useReturnFocus } from './useReturnFocus';
import type {
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../db/schema';
import { formatSignedINR } from '../lib/money';
import { detectPayment, type PaymentMark } from '../lib/spend';
import { formatDateLabel, formatPeriodLabel } from '../lib/dates';

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
 * and, when Kardabra guessed it or the user chose it, the "Choose bill
 * payment" flow. A payment the statement labels itself needs no checking. The parent keys this by statement, so
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
  const { indices: paymentIndices, source } = detectPayment(transactions, {
    priorExpectedDue,
    override: cycle?.paymentOverride,
  });
  const guessed = source === 'amount' || source === 'largest';
  const chosen = cycle?.paymentOverride;
  // Says exactly what the user's pick amounts to now: a re-import can
  // drop rows it named (matchOverride skips those).
  const chosenText =
    chosen === undefined
      ? null
      : chosen.length === 0
        ? 'You said this statement has no bill payment.'
        : paymentIndices.length < chosen.length
          ? 'Some transactions you chose aren’t on this statement any more. Choose again, or reset to automatic.'
          : 'You chose the bill payment for this statement.';

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
    focusNext.current = 'after-reset';
    setFixMode({ mode: 'view' });
  }

  const selecting = fixMode.mode === 'selecting';
  // Save and Cancel go away with the selection; focus returns here.
  const chooseButton = useReturnFocus<HTMLButtonElement>(selecting);
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus moves once the next state has rendered: into the list when
  // choosing starts; after a reset, to Choose if Kardabra still guessed,
  // else (the note is gone) to the heading.
  const focusNext = useRef<'first-check' | 'after-reset' | null>(null);
  useEffect(() => {
    if (focusNext.current === 'first-check') {
      section.current
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.focus();
    } else if (focusNext.current === 'after-reset') {
      (chooseButton.current ?? heading.current)?.focus();
    }
    focusNext.current = null;
  }, [fixMode, source, chooseButton]);
  return (
    <section ref={section}>
      <TotalsWarning
        summary={statement}
        transactions={transactions}
        skippedRows={statement.skippedRows ?? 0}
      />
      <div className="txn-header">
        <h2 ref={heading} tabIndex={-1}>
          {formatPeriodLabel(statement.period)} transactions
        </h2>
        {selecting && (
          <div className="import-actions">
            <button
              className="primary"
              onClick={() => void saveOverride().catch(reportError)}
            >
              Save
            </button>
            <button onClick={() => setFixMode({ mode: 'view' })}>Cancel</button>
          </div>
        )}
      </div>
      {/* One button for the statement, not per row: a payment can be
          several rows (a split payment). */}
      {selecting && (
        <div className="payment-note">
          <p>
            Tick the transaction(s) that paid your bill, then Save. Leave them
            all unticked if this statement has no bill payment.
          </p>
        </div>
      )}
      {!selecting && (guessed || chosenText !== null) && (
        <div className="payment-note">
          {/* A status, so a Save or Reset is announced when the text changes. */}
          <p role="status">
            {chosenText ??
              'Kardabra guessed which transaction is your bill payment. You can choose the correct transaction(s) if we got it wrong.'}
          </p>
          <div className="import-actions">
            <button
              ref={chooseButton}
              onClick={() => {
                focusNext.current = 'first-check';
                setFixMode({
                  mode: 'selecting',
                  checked: new Set(paymentIndices),
                });
              }}
            >
              Choose bill payment
            </button>
            {chosenText !== null && (
              <button onClick={() => void resetOverride().catch(reportError)}>
                Reset to automatic
              </button>
            )}
          </div>
        </div>
      )}
      <div className="table-scroll">
        <table className="txn-table" aria-label="Transactions">
          <thead>
            <tr>
              {selecting && (
                <th>
                  <span className="visually-hidden">Bill payment</span>
                </th>
              )}
              <th>Date</th>
              <th>Payee</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((txn, index) => (
              // Rows have no stable id of their own; position is part of the
              // key, matching the Fix flow's `checked` positions.
              <tr key={`${txn.dateISO}-${txn.payee}-${txn.amount}-${index}`}>
                {fixMode.mode === 'selecting' && (
                  <td>
                    <label className="check-hit">
                      <input
                        type="checkbox"
                        checked={fixMode.checked.has(index)}
                        onChange={() => toggleChecked(index)}
                        aria-label={`Mark ${txn.payee} as bill payment`}
                      />
                    </label>
                  </td>
                )}
                <td className="nowrap">{formatDateLabel(txn.dateISO)}</td>
                <td>
                  {txn.payee}
                  {!selecting && paymentIndices.includes(index) && (
                    <>
                      {' '}
                      <span className="badge">Bill payment</span>
                    </>
                  )}
                </td>
                <td
                  className={
                    txn.amount < 0 ? 'num amount-debit' : 'num amount-credit'
                  }
                >
                  {formatSignedINR(txn.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default StatementTransactions;
