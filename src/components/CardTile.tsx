import { useState } from 'react';
import type { CardRecord, CycleRecord } from '../db/schema';
import { formatINR } from '../lib/money';
import { dueStatus } from '../lib/dueStatus';
import { cycleNeedsPayment } from '../lib/cycles';
import { todayISO } from '../lib/dates';
import { PencilIcon, TrashIcon } from './icons';

interface CardTileProps {
  card: CardRecord;
  cycle: CycleRecord | null;
  /** Statements whose rows don't add up or had rows skipped. */
  statementsToCheck: number;
  onOpen: () => void;
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
  onOpen,
  onTogglePaid,
  onRename,
  onDelete,
}: CardTileProps) {
  const [mode, setMode] = useState<TileMode>({ kind: 'normal' });
  const status = cycle === null ? null : dueStatus(todayISO(), cycle);

  function saveRename() {
    if (mode.kind !== 'renaming') return;
    const trimmed = mode.draft.trim();
    if (trimmed === '') return; // a card must keep some name
    onRename(trimmed);
    setMode({ kind: 'normal' });
  }

  if (mode.kind === 'confirming-delete') {
    return (
      <div className="card-tile">
        <div className="card-tile-header">
          <span className="card-nickname">Delete {card.nickname}?</span>
        </div>
        <p className="card-min-due">
          Removes its statements and transactions from this device. Re-importing
          the files brings everything back.
        </p>
        <div className="import-actions card-action">
          <button className="danger" onClick={() => onDelete()}>
            Delete
          </button>
          <button onClick={() => setMode({ kind: 'normal' })}>Cancel</button>
        </div>
      </div>
    );
  }

  // Not a clickable <div>: the card's name is a real button, stretched over
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
              if (e.key === 'Enter') saveRename();
              if (e.key === 'Escape') setMode({ kind: 'normal' });
            }}
            onBlur={saveRename}
            aria-label={`Nickname for ${card.nickname}`}
            autoFocus
          />
        ) : (
          <h2 className="card-nickname">
            <button type="button" className="card-open" onClick={onOpen}>
              {card.nickname}
            </button>
          </h2>
        )}
        <span className="tile-actions">
          <button
            className="icon-button"
            aria-label={`Rename ${card.nickname}`}
            onClick={() => setMode({ kind: 'renaming', draft: card.nickname })}
          >
            <PencilIcon />
          </button>
          <button
            className="icon-button"
            aria-label={`Delete ${card.nickname}`}
            onClick={() => setMode({ kind: 'confirming-delete' })}
          >
            <TrashIcon />
          </button>
        </span>
      </div>

      <p className="card-amount amount">
        {/* An absent totalDue is not ₹0 — it's a fact the parser never
            recovered from this card's statements, and must read as
            "unknown" rather than silently rendering as free money. But
            when the cycle's spend is known (it almost always is — it's
            computed from the transactions themselves), show that instead
            of a bare "Amount unknown": spend is a real fact about the
            cycle, clearly labeled as spend rather than passed off as the
            bill amount. */}
        {cycle?.totalDue !== undefined
          ? formatINR(cycle.totalDue)
          : cycle?.spend !== undefined
            ? `Spend ${formatINR(cycle.spend)}`
            : 'Amount unknown'}
      </p>

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
          <button className="card-action" onClick={onTogglePaid}>
            {cycle.paidAt === undefined ? 'Mark paid' : 'Undo'}
          </button>
        )}
    </div>
  );
}

export default CardTile;
