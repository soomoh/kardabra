import { useState } from 'react';
import { useReportError } from '../db/DbProvider';
import type { CardRecord } from '../db/schema';
import { formatINR } from '../lib/money';
import { feeDiscrepancyNote } from '../lib/charges';
import { isValidDueDay } from '../lib/dates';
import { PencilIcon, TrashIcon } from './icons';
import { useReturnFocus } from './useReturnFocus';

type FeeType = 'NONE' | 'LTF' | 'FYF' | 'AMOUNT';

const feeAmountOf = (card: CardRecord) =>
  card.feeLabel?.type === 'AMOUNT' ? (card.feeLabel.amount ?? 0) : 0;

interface CardHeaderProps {
  card: CardRecord;
  statementCount: number;
  transactionCount: number;
  /** Net annual fee charged in the trailing year (lib/charges.ts). */
  feeNet: number;
  /** Some statement printed no due date, so the due day decides it. */
  needsDueDay: boolean;
  onSave: (card: CardRecord) => Promise<void>;
  onSaveDueDay: (dueDay: number) => Promise<void>;
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
  needsDueDay,
  onSave,
  onSaveDueDay,
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
  const [dueDayDraft, setDueDayDraft] = useState<string | null>(null);
  const [dueDayError, setDueDayError] = useState<string | null>(null);
  const dueDayButton = useReturnFocus<HTMLButtonElement>(dueDayDraft !== null);
  const renameButton = useReturnFocus<HTMLButtonElement>(
    nicknameDraft !== null,
  );
  const deleteButton = useReturnFocus<HTMLButtonElement>(confirmingDelete);
  const feeEditButton = useReturnFocus<HTMLButtonElement>(
    feeAmountDraft !== null,
  );

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

  async function handleSaveDueDay() {
    if (dueDayDraft === null) return;
    const day = dueDayDraft.trim() === '' ? NaN : Number(dueDayDraft);
    if (!isValidDueDay(day)) {
      setDueDayError('Enter a day of the month, 1 to 31.');
      return;
    }
    setDueDayError(null);
    await onSaveDueDay(day);
    setDueDayDraft(null);
  }

  function cancelDueDay() {
    setDueDayDraft(null);
    setDueDayError(null);
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
        <div className="card-title-row">
          <h1>{card.nickname}</h1>
          {!confirmingDelete && (
            <span className="tile-actions">
              <button
                ref={renameButton}
                className="icon-button"
                aria-label="Rename card"
                onClick={() => setNicknameDraft(card.nickname)}
              >
                <PencilIcon />
              </button>
              <button
                ref={deleteButton}
                className="icon-button"
                aria-label="Delete card"
                onClick={() => setConfirmingDelete(true)}
              >
                <TrashIcon />
              </button>
            </span>
          )}
        </div>
      ) : (
        <div className="rename-row">
          <input
            type="text"
            value={nicknameDraft}
            onChange={(e) => setNicknameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault(); // see useReturnFocus
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
      {confirmingDelete && (
        <div className="delete-confirm">
          <p>
            This removes {card.nickname}, its {statementCount} statement
            {statementCount === 1 ? '' : 's'} and {transactionCount} transaction
            {transactionCount === 1 ? '' : 's'} from this device. There is no
            undo, but importing the statement files again brings everything
            back.
          </p>
          <div className="import-actions">
            <button
              className="danger"
              onClick={() => void onDelete().catch(reportError)}
            >
              Delete permanently
            </button>
            {/* Focus lands on the safe choice. */}
            <button autoFocus onClick={() => setConfirmingDelete(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {dueDayDraft !== null ? (
        <div className="due-day-row">
          <label htmlFor="due-day-input">Due day</label>
          <input
            id="due-day-input"
            type="number"
            min={1}
            max={31}
            step={1}
            inputMode="numeric"
            value={dueDayDraft}
            onChange={(e) => {
              setDueDayDraft(e.target.value);
              setDueDayError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault(); // see useReturnFocus
              if (e.key === 'Enter') void handleSaveDueDay().catch(reportError);
              if (e.key === 'Escape') cancelDueDay();
            }}
            aria-invalid={dueDayError !== null}
            aria-describedby={
              dueDayError ? 'due-day-error due-day-hint' : 'due-day-hint'
            }
            autoFocus
          />
          <button
            className="primary"
            onClick={() => void handleSaveDueDay().catch(reportError)}
          >
            Save
          </button>
          <button onClick={cancelDueDay}>Cancel</button>
          <p id="due-day-hint" className="muted due-day-hint">
            Used when a statement doesn't print its due date.
          </p>
          {dueDayError && (
            <p id="due-day-error" className="error-text" role="alert">
              {dueDayError}
            </p>
          )}
        </div>
      ) : (
        (card.dueDay !== undefined || needsDueDay) && (
          <div className="due-day-row">
            <span className="muted">
              {card.dueDay !== undefined
                ? `Due on day ${card.dueDay} of each month`
                : 'No due day yet'}
            </span>
            <button
              ref={dueDayButton}
              className="link-button"
              aria-label={
                card.dueDay !== undefined ? 'Change due day' : undefined
              }
              onClick={() => setDueDayDraft(String(card.dueDay ?? ''))}
            >
              {card.dueDay !== undefined ? 'Change' : 'Set due day'}
            </button>
          </div>
        )
      )}

      <div className="fee-label-row">
        <label>
          Annual fee{' '}
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
            <option value="AMOUNT">Charges a fee</option>
          </select>
        </label>
        {/* A saved amount collapses to "₹X/yr · Edit", so it doesn't keep
            looking like an unsaved field. */}
        {feeType === 'AMOUNT' &&
          (feeAmountDraft === null ? (
            <>
              <span>{formatINR(feeAmountOf(card))}/yr</span>
              <button
                ref={feeEditButton}
                aria-label="Edit annual fee"
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
                  if (e.key === 'Enter') e.preventDefault(); // see useReturnFocus
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
