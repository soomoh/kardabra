import type { StatementSummary } from '../parser';
import { reconcile } from '../lib/reconcile';
import { formatINR } from '../lib/money';

interface TotalsWarningProps {
  summary: StatementSummary;
  transactions: { amount: number }[];
  skippedRows: number;
}

/** Says so when a statement's rows don't add up to its own totals, or when
 * the parser skipped rows — so a partial read is never silent. Renders
 * nothing when all is well (or there's nothing to check against). */
function TotalsWarning({
  summary,
  transactions,
  skippedRows,
}: TotalsWarningProps) {
  const result = reconcile(summary, transactions);
  const lines: string[] = [];
  if (result.status === 'mismatch') {
    const side =
      result.likely === 'debits'
        ? ' Some purchases may be missing or misread.'
        : result.likely === 'credits'
          ? ' Some payments or refunds may be missing or misread.'
          : ' Some rows may be missing or misread.';
    lines.push(
      `Totals don't add up: the statement says ${formatINR(result.expectedClosing)} is owed, the rows found add up to ${formatINR(result.computedClosing)}.${side}`,
    );
  }
  if (skippedRows > 0) {
    lines.push(
      `${skippedRows} row${skippedRows === 1 ? ' was' : 's were'} skipped because ${skippedRows === 1 ? 'its' : 'their'} date couldn't be read.`,
    );
  }
  if (lines.length === 0) return null;
  return (
    <div className="totals-warning" role="note">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

export default TotalsWarning;
