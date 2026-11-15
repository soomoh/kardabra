import type { CardRecord, CycleRecord } from '../db/schema';
import { formatINR } from '../lib/money';
import { dueStatus } from '../lib/dueStatus';
import { todayISO } from '../lib/dates';
import { routeHash } from '../lib/route';

interface SettledCardRowProps {
  card: CardRecord;
  /** A cycle that needs no payment: paid, a ₹0 bill, or no spend. */
  cycle: CycleRecord;
  statementsToCheck: number;
  onTogglePaid: () => void;
}

/** A settled card on the dashboard: one quiet line, so what still needs
 * paying stays the loudest thing. The amount is kept, small, for checking
 * what was paid; rename and delete live on the card's own page. */
function SettledCardRow({
  card,
  cycle,
  statementsToCheck,
  onTogglePaid,
}: SettledCardRowProps) {
  const status = dueStatus(todayISO(), cycle);
  const paid = cycle.paidAt !== undefined;
  // Only a paid bill's figure is worth repeating; a ₹0 bill or a no-spend
  // cycle already says it all in its status.
  const amount = !paid
    ? null
    : cycle.totalDue !== undefined
      ? `Bill ${formatINR(cycle.totalDue)}`
      : cycle.spend !== undefined
        ? `Spent ${formatINR(cycle.spend)}`
        : null;

  return (
    <li className="settled-row">
      {/* A real link stretched over the row (.card-open::after), as on
          the tiles; the Undo button sits above that layer. */}
      <a
        className="card-open settled-name"
        href={routeHash({ name: 'card', cardId: card.id })}
      >
        {card.nickname}
      </a>
      {amount !== null && (
        <span className="settled-amount amount">{amount}</span>
      )}
      <span className="status-pill" data-tone={status.tone}>
        {status.label}
      </span>
      {statementsToCheck > 0 && (
        <span className="tile-flag">
          {statementsToCheck === 1
            ? '1 statement to check'
            : `${statementsToCheck} statements to check`}
        </span>
      )}
      {paid && (
        <button
          className="link-button"
          data-card-action={card.id}
          onClick={onTogglePaid}
          aria-label={`Undo paid, ${card.nickname}`}
        >
          Undo
        </button>
      )}
    </li>
  );
}

export default SettledCardRow;
