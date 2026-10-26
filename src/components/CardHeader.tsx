import { useState } from 'react';
import { useReportError } from '../db/DbProvider';
import type { CardRecord } from '../db/schema';
import { formatINR } from '../lib/money';
import { feeDiscrepancyNote } from '../lib/charges';

type FeeType = 'NONE' | 'LTF' | 'FYF' | 'AMOUNT';

const feeAmountOf = (card: CardRecord) =>
  card.feeLabel?.type === 'AMOUNT' ? (card.feeLabel.amount ?? 0) : 0;

interface CardHeaderProps {
  card: CardRecord;
  statementCount: number;
  transactionCount: number;
  /** Net annual fee charged in the trailing year (lib/charges.ts). */
  feeNet: number;
  onSave: (card: CardRecord) => Promise<void>;
  onDelete: () => Promise<void>;
}

/** The card's name, due day and fee label, with rename and delete. Kept
 * above the statements so the actions stay in view however long the
 * transaction list grows. */
function CardHeader({
  card,
  statementCount,
  transactionCount,
  feeNet,
  onSave,
  onDelete,
}: CardHeaderProps) {
  const reportError = useReportError();
  // null = not renaming; '' is a real (emptied) draft.
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null);
  // Two-step delete: the first click only arms the confirmation.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // null = showing the saved amount; a string = an edit in progress. Separate
  // from the rename draft: the two controls save independently.
  const [feeAmountDraft, setFeeAmountDraft] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);

  const feeType: FeeType = card.feeLabel?.type ?? 'NONE';
  const discrepancy = feeDiscrepancyNote(card.feeLabel, feeNet);

  async function saveFeeLabel(feeLabel: CardRecord['feeLabel']) {
    // Delete the key rather than store `feeLabel: undefined`, so "not set"
    // is genuinely absent.
    const updated: CardRecord = { ...card };
    if (feeLabel === undefined) delete updated.feeLabel;
    else updated.feeLabel = feeLabel;
    await onSave(updated);
  }

  async function handleFeeTypeChange(newType: FeeType) {
    if (newType === 'NONE') {
      await saveFeeLabel(undefined);
      setFeeAmountDraft(null);
    } else if (newType === 'AMOUNT') {
      const amount = feeAmountOf(card);
      await saveFeeLabel({ type: 'AMOUNT', amount });
      setFeeAmountDraft(String(amount));
    } else {
      await saveFeeLabel({ type: newType });
      setFeeAmountDraft(null);
    }
  }

  async function handleSaveFeeAmount() {
    if (feeAmountDraft === null) return;
    // Number('') is 0 — an empty box must not silently save a ₹0 fee.
    const amount = feeAmountDraft.trim() === '' ? NaN : Number(feeAmountDraft);
    if (!Number.isFinite(amount) || amount < 0) {
      setFeeError('Enter the annual fee as an amount of 0 or more.');
      return;
    }
    setFeeError(null);
    await saveFeeLabel({ type: 'AMOUNT', amount });
    setFeeAmountDraft(null);
  }

  async function handleRenameSave() {
    if (nicknameDraft === null) return;
    const trimmed = nicknameDraft.trim();
    if (trimmed === '') return; // a card must keep some name
    await onSave({ ...card, nickname: trimmed });
    setNicknameDraft(null);
  }

  return (
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
              if (e.key === 'Enter') void handleRenameSave().catch(reportError);
              if (e.key === 'Escape') setNicknameDraft(null);
            }}
            aria-label="Card nickname"
            autoFocus
          />
          <button
            className="primary"
            onClick={() => void handleRenameSave().catch(reportError)}
            disabled={nicknameDraft.trim() === ''}
          >
            Save
          </button>
          <button onClick={() => setNicknameDraft(null)}>Cancel</button>
        </div>
      )}
      {card.dueDay !== undefined && (
        <p className="muted">Due on day {card.dueDay} of each month</p>
      )}

      {nicknameDraft === null && !confirmingDelete && (
        <div className="import-actions">
          <button onClick={() => setNicknameDraft(card.nickname)}>
            Rename
          </button>
          <button className="danger" onClick={() => setConfirmingDelete(true)}>
            Delete card
          </button>
        </div>
      )}
      {confirmingDelete && (
        <div>
          <p>
            This removes {card.nickname}, its {statementCount} statement
            {statementCount === 1 ? '' : 's'} and {transactionCount} transaction
            {transactionCount === 1 ? '' : 's'} from this device. There is no
            undo — but re-importing the statement files brings everything back.
          </p>
          <div className="import-actions">
            <button
              className="danger"
              onClick={() => void onDelete().catch(reportError)}
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
            value={feeType}
            onChange={(e) =>
              void handleFeeTypeChange(e.target.value as FeeType).catch(
                reportError,
              )
            }
          >
            <option value="NONE">Not set</option>
            <option value="LTF">Lifetime free</option>
            <option value="FYF">First year free</option>
            <option value="AMOUNT">Paid</option>
          </select>
        </label>
        {/* A saved amount collapses to "₹X/yr · Edit", so it doesn't keep
            looking like an unsaved field. */}
        {feeType === 'AMOUNT' &&
          (feeAmountDraft === null ? (
            <>
              <span>{formatINR(feeAmountOf(card))}/yr</span>
              <button
                onClick={() => setFeeAmountDraft(String(feeAmountOf(card)))}
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
                  if (e.key === 'Enter')
                    void handleSaveFeeAmount().catch(reportError);
                  if (e.key === 'Escape') setFeeAmountDraft(null);
                }}
                aria-label="Annual fee amount"
                aria-invalid={feeError !== null}
                aria-describedby={feeError ? 'fee-error' : undefined}
                autoFocus
              />
              <button
                className="primary"
                onClick={() => void handleSaveFeeAmount().catch(reportError)}
              >
                Save
              </button>
              <button
                onClick={() => {
                  setFeeAmountDraft(null);
                  setFeeError(null);
                }}
              >
                Cancel
              </button>
              {feeError && (
                <p id="fee-error" className="error-text" role="alert">
                  {feeError}
                </p>
              )}
            </>
          ))}
      </div>
      {discrepancy !== null && <p className="fee-discrepancy">{discrepancy}</p>}
    </header>
  );
}

export default CardHeader;
