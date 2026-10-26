import { useEffect, useRef, useState } from 'react';
import type { CardRecord, CycleRecord } from '../db/schema';
import { formatINR } from '../lib/money';
import { dueStatus } from '../lib/dueStatus';
import { cycleNeedsPayment } from '../lib/cycles';
import { todayISO } from '../lib/dates';
import { routeHash } from '../lib/route';
import { PencilIcon, TrashIcon } from './icons';

interface CardTileProps {
  card: CardRecord;
  cycle: CycleRecord | null;
  /** Statements whose rows don't add up or had rows skipped. */
  statementsToCheck: number;
  /** This tile's "Mark paid" is the dashboard's one primary action (the
   * most urgent unpaid card). */
  primary: boolean;
  onTogglePaid: () => void;
  onRename: (nickname: string) => void;
  onDelete: () => void;
}

/** The tile's own little state machine (same pattern as ImportPage's
 * ImportState): renaming and confirming-delete are modes the whole tile
 * is in, not independent booleans that could both be true. */
type TileMode =
  | { kind: 'normal' }
  | { kind: 'renaming'; draft: string }
  | { kind: 'confirming-delete' };

/** One card's tile on the dashboard. A thin declarative shell — every
 * decision about what to say (`formatINR`, `dueStatus`) is made by a
 * tested pure function elsewhere; this component just arranges the
 * results. Rename/delete mutations are the parent's job (props down,
 * events up); the tile only owns which mode it's displaying.
 *
 * What the tile deliberately does NOT show: the card's last-4 digits and
 * the statement minimum-due. Both are unavailable for some banks (ICICI
 * web exports carry no readable card number; not every statement states
 * a minimum), and a field that appears on some tiles and not others reads
 * as broken. The rule is "show it for every card or for none": the
 * nickname identifies the card, and the full per-statement detail
 * (including min due where present) lives in the card view. */
function CardTile({
  card,
  cycle,
  statementsToCheck,
  primary,
  onTogglePaid,
  onRename,
  onDelete,
}: CardTileProps) {
  const [mode, setMode] = useState<TileMode>({ kind: 'normal' });
  const status = cycle === null ? null : dueStatus(todayISO(), cycle);
  const renameButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  // Leaving a mode unmounts the focused control: hand focus back to the
  // button that opened it. Which one, not the element: the delete button
  // isn't mounted while its confirmation shows.
  const returnFocusTo = useRef<'rename' | 'delete' | null>(null);
  // Escape cancels; the blur that can follow must not save the draft.
  const cancelled = useRef(false);
  useEffect(() => {
    if (mode.kind !== 'normal' || returnFocusTo.current === null) return;
    const target =
      returnFocusTo.current === 'rename' ? renameButton : deleteButton;
    target.current?.focus();
    returnFocusTo.current = null;
  }, [mode.kind]);

  function leave(to: 'rename' | 'delete' | null) {
    returnFocusTo.current = to;
    setMode({ kind: 'normal' });
  }

  /** `from`: the opener to refocus — null when the save came from focus
   * moving elsewhere, which must stay where the user put it. */
  function saveRename(from: 'rename' | null) {
    if (mode.kind !== 'renaming' || cancelled.current) return;
    const trimmed = mode.draft.trim();
    if (trimmed === '') return; // a card must keep some name
    onRename(trimmed);
    leave(from);
  }

  if (mode.kind === 'confirming-delete') {
    return (
      <div className="card-tile">
        <div className="card-tile-header">
          <h2 className="card-nickname">Delete {card.nickname}?</h2>
        </div>
        <p className="card-min-due">
          Removes its statements and transactions from this device. Importing
          the files again brings everything back.
        </p>
        <div className="import-actions card-action">
          <button className="danger" onClick={() => onDelete()}>
            Delete
          </button>
          {/* Focus lands on the safe choice. */}
          <button autoFocus onClick={() => leave('delete')}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Not a clickable <div>: the card's name is a real link, stretched over
  // the tile in CSS (.card-open::after) so a click anywhere opens it. The
  // other buttons sit above that layer, siblings rather than nested.
  return (
    <div className="card-tile">
      <div className="card-tile-header">
        {mode.kind === 'renaming' ? (
          <input
            type="text"
            value={mode.draft}
            onChange={(e) =>
              setMode({ kind: 'renaming', draft: e.target.value })
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault(); // see useReturnFocus
              if (e.key === 'Enter') saveRename('rename');
              if (e.key === 'Escape') {
                cancelled.current = true;
                leave('rename');
              }
            }}
            onBlur={() => saveRename(null)}
            aria-label={`Nickname for ${card.nickname}`}
            autoFocus
          />
        ) : (
          <h2 className="card-nickname">
            <a
              className="card-open"
              href={routeHash({ name: 'card', cardId: card.id })}
            >
              {card.nickname}
            </a>
          </h2>
        )}
        <span className="tile-actions">
          <button
            className="icon-button"
            aria-label={`Rename ${card.nickname}`}
            ref={renameButton}
            onClick={() => {
              cancelled.current = false;
              setMode({ kind: 'renaming', draft: card.nickname });
            }}
          >
            <PencilIcon />
          </button>
          <button
            className="icon-button"
            ref={deleteButton}
            aria-label={`Delete ${card.nickname}`}
            onClick={() => setMode({ kind: 'confirming-delete' })}
          >
            <TrashIcon />
          </button>
        </span>
      </div>

      {/* What the figure is: the bill (to pay, or paid), or — when the
          statement printed no total — what was spent, which is a fact
          about the cycle, never passed off as the bill. An absent total
          is not ₹0. */}
      {cycle?.totalDue !== undefined ? (
        <>
          <p className="card-amount-label">
            {cycleNeedsPayment(cycle) ? 'To pay' : 'Bill'}
          </p>
          <p className="card-amount amount">{formatINR(cycle.totalDue)}</p>
        </>
      ) : cycle?.spend !== undefined ? (
        <>
          <p className="card-amount-label">Spent this cycle</p>
          <p className="card-amount amount">{formatINR(cycle.spend)}</p>
        </>
      ) : (
        <p className="card-amount">Amount unknown</p>
      )}

      {status !== null && (
        <p className="due-status">
          {/* Styled per tone in index.css; unpaid tones carry the hatched
              "not paid yet" dot. */}
          <span className="status-pill" data-tone={status.tone}>
            {(status.tone === 'ok' ||
              status.tone === 'soon' ||
              status.tone === 'overdue') && (
              <span className="status-dot hatch" aria-hidden="true" />
            )}
            {status.label}
          </span>
        </p>
      )}

      {statementsToCheck > 0 && (
        <p className="tile-flag">
          {statementsToCheck === 1
            ? '1 statement to check'
            : `${statementsToCheck} statements to check`}
        </p>
      )}

      {/* "Mark paid" only makes sense when something is owed; "Undo" only
          when the user themselves marked it paid. A ₹0/no-spend cycle
          gets neither — there's no action to take on it. The `card-action`
          class bottom-anchors it (margin-top:auto) so it sits at the same
          spot on every tile regardless of how much content is above. */}
      {cycle !== null &&
        (cycleNeedsPayment(cycle) || cycle.paidAt !== undefined) && (
          <button
            // Undo is a quiet link; the most urgent "Mark paid" is primary.
            className={
              cycle.paidAt !== undefined
                ? 'card-action link-button'
                : primary
                  ? 'card-action primary'
                  : 'card-action'
            }
            onClick={onTogglePaid}
            // The visible words first, then which card (several tiles).
            aria-label={`${cycle.paidAt === undefined ? 'Mark paid' : 'Undo paid'}, ${card.nickname}`}
          >
            {cycle.paidAt === undefined ? 'Mark paid' : 'Undo'}
          </button>
        )}
    </div>
  );
}

export default CardTile;
