import { useEffect, useState } from 'react';
import { useDb } from '../db/useDb';
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
import { formatINR, formatSignedINR } from '../lib/money';
import {
  identifyPaymentIndices,
  sumOfCredits,
  billUnderpaid,
  type PaymentMark,
} from '../lib/spend';
import { chargeTotals, annualFeeNet } from '../lib/charges';
import { todayISO, formatPeriodLabel, formatDateLabel } from '../lib/dates';
import type { View } from '../App';

type FeeType = 'NONE' | 'LTF' | 'FYF' | 'AMOUNT';

function feeTypeOf(card: CardRecord): FeeType {
  return card.feeLabel?.type ?? 'NONE';
}

/** This statement's interest/late-charge hint line, or null if it has
 * neither — a signal that a statement might carry a carried-forward
 * balance (see this module's — and charges.ts's — sign-aware netting: a
 * fee reversal would already have netted itself out here). */
function chargeHintForStatement(
  transactions: TransactionRecord[],
  statementId: string,
): string | null {
  const totals = chargeTotals(
    transactions.filter((txn) => txn.statementId === statementId),
  );
  const flagged = totals.interest + totals.late;
  if (flagged <= 0) return null;
  return `includes ${formatINR(flagged)} interest/late charges`;
}

/**
 * The fee-label discrepancy note, or null when there's nothing to say.
 *
 * Design: a silent watcher, not a report — no trailing-cost total, no
 * per-category breakdown, nothing rendered at all in the normal case.
 * The note IS the feature: it only speaks when an annual fee was
 * actually charged (net of reversals, trailing 365 days) on a card
 * whose label says that shouldn't happen — 'LTF' (never) or 'FYF' (not
 * after year one, which can't be verified, so the note asks rather than
 * asserts). A card labeled 'AMOUNT' paying a fee is expected, and an
 * unlabeled card promised nothing — both stay silent.
 */
function feeDiscrepancyNote(card: CardRecord, feeNet: number): string | null {
  const label = card.feeLabel;
  if (label === undefined) return null;
  if (feeNet <= 0) return null;

  if (label.type === 'LTF') {
    return `${formatINR(feeNet)} annual fee detected on a card marked lifetime free — worth verifying with the bank.`;
  }
  if (label.type === 'FYF') {
    return `${formatINR(feeNet)} annual fee detected — expected only from the second year; verify if this card is still in year one.`;
  }
  return null; // 'AMOUNT': a fee is exactly what the label promised
}

interface CardDetailProps {
  cardId: string;
  setView: (view: View) => void;
}

/** What a statement's payment was expected to clear: the *prior*
 * statement's Total Amount Due, or — for banks whose export carries no
 * total — that prior statement's own spend, read from its cycle (the
 * single source of truth for "what did this cycle cost" — see schema.ts's
 * CycleRecord.spend comment) as the best proxy for what was owed. null
 * when there's no prior statement to compare against (the oldest one
 * can't be reconciled), or — defensively — when the prior cycle's spend
 * hasn't been computed (shouldn't normally happen once
 * recomputeCardSpends has run for this card). */
function priorExpectedDue(
  priorStatement: StatementRecord | undefined,
  priorCycle: CycleRecord | undefined,
): number | null {
  if (priorStatement === undefined) return null;
  return priorStatement.totalDue ?? priorCycle?.spend ?? null;
}

/** Row-selection state for the "Fix bill payment" flow: a discriminated
 * union, not a boolean + a Set kept in sync by hand, so "which rows are
 * checked" simply doesn't exist as a concept outside 'selecting' mode.
 * `checked` holds indices into `selectedTransactions`
 * (that statement's own array, rebuilt fresh on every render) — not
 * TransactionRecords themselves, since the checkboxes need to toggle by
 * position in the currently-rendered table. */
type FixMode = { mode: 'view' } | { mode: 'selecting'; checked: Set<number> };

function CardDetail({ cardId, setView }: CardDetailProps) {
  const db = useDb();
  const { version, bump } = useDataVersion();
  const [card, setCard] = useState<CardRecord | null>(null);
  const [statements, setStatements] = useState<StatementRecord[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [cycles, setCycles] = useState<CycleRecord[]>([]);
  const [selectedStatementId, setSelectedStatementId] = useState<string | null>(
    null,
  );
  // view = normal browsing; selecting = the "Fix bill payment" flow is
  // open on the currently-selected statement (see FixMode's comment).
  const [fixMode, setFixMode] = useState<FixMode>({ mode: 'view' });
  // null = not renaming; a string = the draft nickname being typed.
  // (The sentinel-vs-value distinction again: '' is a real draft the user
  // has emptied out, null is "no rename in progress".)
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null);
  // Two-step delete: the first click only arms the confirmation.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // null = showing the committed amount (card.feeLabel.amount); a string
  // = a local edit in progress, not yet saved. Same sentinel-vs-value
  // shape as nicknameDraft above — mirrored here rather than sharing one
  // state, because the two controls save independently (a fee-amount
  // edit in progress must not block or get clobbered by a rename).
  const [feeAmountDraft, setFeeAmountDraft] = useState<string | null>(null);

  async function saveFeeLabel(feeLabel: CardRecord['feeLabel']) {
    if (db === null || card === null) return;
    // A shallow-copy-then-delete, not a conditional spread: this is a
    // local mutation of a fresh object (never the `card` state itself),
    // and it's the plainest way to go from "has a feeLabel key" to "has
    // none at all" — storing `feeLabel: undefined` would leave the key
    // present with an undefined value instead of genuinely absent.
    const updated: CardRecord = { ...card };
    if (feeLabel === undefined) {
      delete updated.feeLabel;
    } else {
      updated.feeLabel = feeLabel;
    }
    await putCard(db, updated);
    bump();
  }

  async function handleFeeTypeChange(newType: FeeType) {
    if (newType === 'NONE') {
      await saveFeeLabel(undefined);
      setFeeAmountDraft(null);
      return;
    }
    if (newType === 'AMOUNT') {
      const currentAmount =
        card?.feeLabel?.type === 'AMOUNT' ? (card.feeLabel.amount ?? 0) : 0;
      await saveFeeLabel({ type: 'AMOUNT', amount: currentAmount });
      setFeeAmountDraft(String(currentAmount));
      return;
    }
    await saveFeeLabel({ type: newType });
    setFeeAmountDraft(null);
  }

  async function handleSaveFeeAmount() {
    if (feeAmountDraft === null) return;
    const amount = Number(feeAmountDraft);
    if (!Number.isFinite(amount) || amount < 0) return; // bad input: just don't save it
    await saveFeeLabel({ type: 'AMOUNT', amount });
    setFeeAmountDraft(null);
  }

  async function handleRenameSave() {
    if (db === null || card === null || nicknameDraft === null) return;
    const trimmed = nicknameDraft.trim();
    if (trimmed === '') return; // a card must keep some name
    await putCard(db, { ...card, nickname: trimmed });
    setNicknameDraft(null);
    bump();
  }

  async function handleDeleteConfirmed() {
    if (db === null) return;
    await deleteCardCascade(db, cardId);
    bump();
    setView({ name: 'dashboard' });
  }

  useEffect(() => {
    if (db === null) return;
    let cancelled = false;

    (async () => {
      // getStatementsForCard already returns newest-first (by period).
      const [loadedCard, loadedStatements, loadedTransactions, loadedCycles] =
        await Promise.all([
          getCard(db, cardId),
          getStatementsForCard(db, cardId),
          getTransactionsForCard(db, cardId),
          getCyclesForCard(db, cardId),
        ]);
      if (cancelled) return;

      setCard(loadedCard ?? null);
      setStatements(loadedStatements);
      setTransactions(loadedTransactions);
      setCycles(loadedCycles);
      // Default selection: the newest statement. Kept across a refresh
      // (e.g. `version` bumping because a cycle was marked paid) as long
      // as the previously-selected statement still exists.
      setSelectedStatementId((current) =>
        current !== null && loadedStatements.some((s) => s.id === current)
          ? current
          : (loadedStatements[0]?.id ?? null),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [db, cardId, version]);

  // Switching which statement is selected must always drop back to plain
  // browsing — a half-finished payment-row selection made against the
  // PREVIOUS statement's transactions would silently apply to the wrong
  // one if left open across the switch.
  useEffect(() => {
    setFixMode({ mode: 'view' });
  }, [selectedStatementId]);

  const backLink = (
    <button
      className="back-link"
      onClick={() => setView({ name: 'dashboard' })}
    >
      &larr; Back to dashboard
    </button>
  );

  if (card === null) {
    return (
      <div>
        {backLink}
        <p>Loading…</p>
      </div>
    );
  }

  // cyclesByPeriod: the lookup every per-statement view below reads
  // spend from — cycle.spend is the single source of truth (see
  // schema.ts's CycleRecord.spend comment), never recomputed here.
  const cyclesByPeriod = new Map(cycles.map((c) => [c.period, c]));

  const selectedIndex = statements.findIndex(
    (s) => s.id === selectedStatementId,
  );
  const selectedStatement =
    selectedIndex === -1 ? undefined : statements[selectedIndex];
  const selectedCycle =
    selectedStatement === undefined
      ? undefined
      : cyclesByPeriod.get(selectedStatement.period);
  // statements is newest-first, so index+1 is the immediately older one.
  const selectedPriorStatement =
    selectedIndex === -1 ? undefined : statements[selectedIndex + 1];
  const selectedPriorCycle =
    selectedPriorStatement === undefined
      ? undefined
      : cyclesByPeriod.get(selectedPriorStatement.period);

  const selectedTransactions = transactions
    .filter((txn) => txn.statementId === selectedStatementId)
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  // The confidence-ranked payment SET for the selected statement (see
  // lib/spend.ts) — possibly several rows (a split payment), possibly
  // none. This drives both the view-mode "· bill payment" label(s) and
  // the Fix flow's pre-checked boxes, so the two can never show a
  // different answer for the same statement.
  const selectedPaymentIndices = identifyPaymentIndices(selectedTransactions, {
    priorExpectedDue: priorExpectedDue(
      selectedPriorStatement,
      selectedPriorCycle,
    ),
    override: selectedCycle?.paymentOverride,
  });

  function handleStartFix() {
    setFixMode({ mode: 'selecting', checked: new Set(selectedPaymentIndices) });
  }

  function toggleChecked(index: number) {
    setFixMode((current) => {
      if (current.mode !== 'selecting') return current; // guard: only called from the row checkboxes, which only render in this mode
      const next = new Set(current.checked);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return { mode: 'selecting', checked: next };
    });
  }

  async function handleSaveOverride() {
    if (db === null || fixMode.mode !== 'selecting') return;
    if (selectedStatement === undefined) return;
    // Stored by VALUE (amount + payee), not by index — see PaymentMark's
    // comment: this exact statement's transactions get deleted and
    // recreated whole on the next re-import, so an index would point at
    // whatever happens to land in that slot next time, not the row the
    // user actually meant.
    const marks: PaymentMark[] = [...fixMode.checked].map((index) => ({
      amount: selectedTransactions[index].amount,
      payee: selectedTransactions[index].payee,
    }));
    await setPaymentOverride(db, cardId, selectedStatement.period, marks);
    setFixMode({ mode: 'view' });
    bump();
  }

  async function handleResetOverride() {
    if (db === null || selectedStatement === undefined) return;
    await setPaymentOverride(db, cardId, selectedStatement.period, undefined);
    setFixMode({ mode: 'view' });
    bump();
  }

  // Net annual fee across every transaction this card has (trailing 365
  // days), not just the selected statement — feeds only the discrepancy
  // note below; there is deliberately no visible cost report.
  const feeNet = annualFeeNet(transactions, todayISO());
  const discrepancy = feeDiscrepancyNote(card, feeNet);

  return (
    <div>
      {backLink}
      <header className="card-detail-header">
        {nicknameDraft === null ? (
          <h1>{card.nickname}</h1>
        ) : (
          <div className="rename-row">
            <input
              type="text"
              value={nicknameDraft}
              onChange={(e) => setNicknameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRenameSave();
                if (e.key === 'Escape') setNicknameDraft(null);
              }}
              aria-label="Card nickname"
              autoFocus
            />
            <button
              onClick={() => void handleRenameSave()}
              disabled={nicknameDraft.trim() === ''}
            >
              Save
            </button>
            <button onClick={() => setNicknameDraft(null)}>Cancel</button>
          </div>
        )}
        {card.dueDay !== undefined && <p>Due day: {card.dueDay}</p>}

        {/* Management actions live up here, always visible — not below a
            transactions list that can grow arbitrarily long. */}
        {nicknameDraft === null && !confirmingDelete && (
          <div className="import-actions">
            <button onClick={() => setNicknameDraft(card.nickname)}>
              Rename
            </button>
            <button
              className="danger"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete card
            </button>
          </div>
        )}
        {confirmingDelete && (
          <div>
            <p>
              This removes {card.nickname}, its {statements.length} statement
              {statements.length === 1 ? '' : 's'} and {transactions.length}{' '}
              transaction
              {transactions.length === 1 ? '' : 's'} from this device. There is
              no undo — but re-importing the statement files brings everything
              back.
            </p>
            <div className="import-actions">
              <button
                className="danger"
                onClick={() => void handleDeleteConfirmed()}
              >
                Delete permanently
              </button>
              <button onClick={() => setConfirmingDelete(false)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="fee-label-row">
          <label>
            Fee:{' '}
            <select
              value={feeTypeOf(card)}
              onChange={(e) =>
                void handleFeeTypeChange(e.target.value as FeeType)
              }
            >
              <option value="NONE">Not set</option>
              <option value="LTF">Lifetime free</option>
              <option value="FYF">First year free</option>
              <option value="AMOUNT">Paid</option>
            </select>
          </label>
          {/* AMOUNT is display-first: once saved, the input collapses to a
              read-only "₹X · Edit" so a saved value doesn't keep looking
              like a live, unsaved field — a Save that leaves the box
              editable reads as "did that work?". feeAmountDraft null =
              showing the committed value; non-null = editing. */}
          {feeTypeOf(card) === 'AMOUNT' &&
            (feeAmountDraft === null ? (
              <>
                <span>
                  {formatINR(
                    card.feeLabel?.type === 'AMOUNT'
                      ? (card.feeLabel.amount ?? 0)
                      : 0,
                  )}
                  /yr
                </span>
                <button
                  onClick={() =>
                    setFeeAmountDraft(
                      String(
                        card.feeLabel?.type === 'AMOUNT'
                          ? (card.feeLabel.amount ?? 0)
                          : 0,
                      ),
                    )
                  }
                >
                  Edit
                </button>
              </>
            ) : (
              <>
                <input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={feeAmountDraft}
                  onChange={(e) => setFeeAmountDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSaveFeeAmount();
                    if (e.key === 'Escape') setFeeAmountDraft(null);
                  }}
                  aria-label="Annual fee amount"
                  autoFocus
                />
                <button onClick={() => void handleSaveFeeAmount()}>Save</button>
                <button onClick={() => setFeeAmountDraft(null)}>Cancel</button>
              </>
            ))}
        </div>
        {discrepancy !== null && (
          <p className="fee-discrepancy">{discrepancy}</p>
        )}
      </header>

      <section>
        <h2>Statements</h2>
        {statements.length === 0 ? (
          <p>No statements imported yet.</p>
        ) : (
          <ul className="statement-list">
            {statements.map((statement, index) => {
              // getStatementsForCard returns newest-first, so anything
              // past index 0 has a newer statement above it and is
              // settled by successor (lib/cycles.ts): its total was
              // absorbed into the newer statement's own Total Amount
              // Due, so its due date is no longer a live deadline.
              const settled = index > 0;
              const chargeHint = chargeHintForStatement(
                transactions,
                statement.id,
              );
              const stmtTxns = transactions.filter(
                (txn) => txn.statementId === statement.id,
              );
              const spend = cyclesByPeriod.get(statement.period)?.spend ?? 0;
              // Reconciliation: did this statement's total CREDITS (payment
              // plus any refunds) cover the *prior* statement's due? If
              // not, last cycle likely wasn't paid in full and interest may
              // follow — a soft, forward-looking warning, distinct from
              // chargeHint, which reports interest already billed. Summing
              // every credit (not just the identified payment) avoids a
              // false warning when a refund lands alongside a partial
              // payment — see lib/spend.ts's billUnderpaid comment.
              // statements is newest-first, so index+1 is older.
              const priorStatement = statements[index + 1];
              const priorCycle =
                priorStatement === undefined
                  ? undefined
                  : cyclesByPeriod.get(priorStatement.period);
              const underpaid = billUnderpaid(
                sumOfCredits(stmtTxns),
                priorExpectedDue(priorStatement, priorCycle),
              );
              return (
                <li key={statement.id}>
                  <button
                    className={
                      statement.id === selectedStatementId
                        ? 'statement-row selected'
                        : 'statement-row'
                    }
                    onClick={() => setSelectedStatementId(statement.id)}
                  >
                    <span className="statement-period">
                      {formatPeriodLabel(statement.period)}
                    </span>
                    <span>{statement.fileName}</span>
                    <span>{statement.txnCount} txns</span>
                    <span>Spend {formatINR(spend)}</span>
                    {chargeHint !== null && (
                      <span className="charge-hint">{chargeHint}</span>
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

      {selectedStatementId !== null && (
        <section>
          <div className="txn-header">
            <h2>Transactions</h2>
            {/* One button for the whole statement, not one per row: the
                payment can be a SET of rows (a split payment), so "fix" is
                a selection of however many rows the user picks, not a
                single toggle. */}
            {fixMode.mode === 'view' ? (
              <div className="import-actions">
                <button onClick={handleStartFix}>Fix bill payment</button>
                {selectedCycle?.paymentOverride !== undefined && (
                  <button onClick={() => void handleResetOverride()}>
                    Reset to automatic
                  </button>
                )}
              </div>
            ) : (
              <div className="import-actions">
                <button onClick={() => void handleSaveOverride()}>Save</button>
                <button onClick={() => setFixMode({ mode: 'view' })}>
                  Cancel
                </button>
              </div>
            )}
          </div>
          <table className="txn-table">
            <thead>
              <tr>
                {fixMode.mode === 'selecting' && <th></th>}
                <th>Date</th>
                <th>Payee</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {selectedTransactions.map((txn, index) => {
                // TransactionRecord has no id field of its own (the
                // store's key is an out-of-line autoIncrement — see
                // schema.ts) — there's no stable id to key on, so a
                // composite of the fields that make a row unique-enough,
                // plus its position, stands in. The Fix flow's checkboxes
                // track this same `index` (position within
                // selectedTransactions), per this file's FixMode comment.
                const rowKey = `${txn.dateISO}-${txn.payee}-${txn.amount}-${index}`;
                return (
                  <tr key={rowKey}>
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
                      {fixMode.mode === 'view' &&
                        selectedPaymentIndices.includes(index) && (
                          <span className="credit-label"> · bill payment</span>
                        )}
                    </td>
                    <td
                      className={
                        txn.amount < 0 ? 'amount-debit' : 'amount-credit'
                      }
                    >
                      {formatSignedINR(txn.amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export default CardDetail;
