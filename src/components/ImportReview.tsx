import type { ReactNode } from 'react';
import TotalsWarning from './TotalsWarning';
import { cardInputKey, type FileOutcome } from '../import/plan';
import type { CommitUserInput } from '../import/commit';
import { buildFeedbackReport, feedbackEntriesFor } from '../import/feedback';
import {
  outcomeFileName,
  planIsComplete,
  questionOwners,
  suggestedName,
} from '../import/review';
import {
  formatDateLabel,
  formatPeriodLabel,
  isValidDueDay,
} from '../lib/dates';

interface ImportReviewProps {
  outcomes: FileOutcome[];
  inputs: CommitUserInput;
  committing: boolean;
  commitError?: string;
  /** Number-masked diagnostics of unreadable files, by file name. */
  diagnostics: Map<string, string>;
  /** The drop zone, so more files can be added while reviewing. */
  dropzone: ReactNode;
  onNickname: (key: string, value: string) => void;
  /** null when the box was emptied — "no answer yet", not day 0. */
  onDueDay: (key: string, value: number | null) => void;
  onStartOver: () => void;
  onCommit: () => void;
}

/** What will happen to each dropped file, and the few answers the plan
 * needs before anything is written. */
function ImportReview({
  outcomes,
  inputs,
  committing,
  commitError,
  diagnostics,
  dropzone,
  onNickname,
  onDueDay,
  onStartOver,
  onCommit,
}: ImportReviewProps) {
  const owners = questionOwners(outcomes);
  const feedbackEntries = feedbackEntriesFor(outcomes, diagnostics);

  function downloadReport() {
    const blob = new Blob([buildFeedbackReport(feedbackEntries)], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'kardabra-unreadable-statements.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Import statements</h1>
      {!committing && dropzone}

      <OutcomeSection
        title="New statements"
        outcomes={outcomes}
        kind="new-statement"
      >
        {(outcome) =>
          outcome.kind === 'new-statement' && (
            <NewStatementDetails
              outcome={outcome}
              inputs={inputs}
              asksName={owners.name.has(outcome.parsed.fileName)}
              asksDueDay={owners.dueDay.has(outcome.parsed.fileName)}
              onNickname={onNickname}
              onDueDay={onDueDay}
            />
          )
        }
      </OutcomeSection>

      <OutcomeSection
        title="Already imported"
        outcomes={outcomes}
        kind="duplicate"
      >
        {(outcome) =>
          outcome.kind === 'duplicate' && (
            <>
              <span>
                already imported ({outcome.existingTxnCount} txns) — this file:{' '}
                {outcome.newTxnCount}
              </span>
              {outcome.supersedes && (
                <span className="badge">will replace</span>
              )}
            </>
          )
        }
      </OutcomeSection>

      <OutcomeSection title="Skipped" outcomes={outcomes} kind="rejected">
        {(outcome) => outcome.kind === 'rejected' && outcome.advice}
      </OutcomeSection>

      <OutcomeSection title="Failed" outcomes={outcomes} kind="failed">
        {(outcome) => outcome.kind === 'failed' && outcome.message}
      </OutcomeSection>

      {feedbackEntries.length > 0 && (
        <section>
          <p className="muted">
            Kardabra couldn't read{' '}
            {feedbackEntries.length === 1 ? 'one file' : 'some files'}. Download
            a local report to help add support — it captures the file's
            structure with numbers masked, stays on your device, and is yours to
            review before sharing.
          </p>
          <button onClick={downloadReport}>Download report</button>
        </section>
      )}

      {!committing && commitError !== undefined && (
        <p className="error-text" role="alert">
          Import failed: {commitError}
        </p>
      )}

      <div className="import-actions">
        <button onClick={onStartOver} disabled={committing}>
          Start over
        </button>
        <button
          className="primary"
          onClick={onCommit}
          disabled={committing || !planIsComplete(outcomes, inputs)}
        >
          {committing ? 'Importing…' : 'Import'}
        </button>
      </div>
    </div>
  );
}

/** One titled list of the plan's outcomes of one kind; nothing when there
 * are none. */
function OutcomeSection({
  title,
  outcomes,
  kind,
  children,
}: {
  title: string;
  outcomes: FileOutcome[];
  kind: FileOutcome['kind'];
  children: (outcome: FileOutcome) => ReactNode;
}) {
  const ofKind = outcomes.filter((o) => o.kind === kind);
  if (ofKind.length === 0) return null;
  return (
    <section>
      <h2>{title}</h2>
      <ul className="plan-list">
        {ofKind.map((outcome) => (
          <li key={outcomeFileName(outcome)} className="plan-row">
            <div className="plan-row-file">{outcomeFileName(outcome)}</div>
            <div className="plan-row-details">{children(outcome)}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NewStatementDetails({
  outcome,
  inputs,
  asksName,
  asksDueDay,
  onNickname,
  onDueDay,
}: {
  outcome: Extract<FileOutcome, { kind: 'new-statement' }>;
  inputs: CommitUserInput;
  asksName: boolean;
  asksDueDay: boolean;
  onNickname: (key: string, value: string) => void;
  onDueDay: (key: string, value: number | null) => void;
}) {
  const key = cardInputKey(outcome.cardRef, outcome.parsed.fileName);
  const dueDay = inputs.dueDays.get(key);
  const { summary } = outcome.parsed;
  return (
    <>
      {outcome.cardRef.kind === 'existing' ? (
        <span>{outcome.cardRef.nickname}</span>
      ) : asksName ? (
        // A visible label, not just a box: the nickname is the only thing
        // that identifies the card on the dashboard (no card number shown).
        <label className="nickname-field">
          Name this card
          <input
            type="text"
            value={inputs.nicknames.get(key) ?? ''}
            onChange={(e) => onNickname(key, e.target.value)}
            placeholder={suggestedName(outcome)}
            aria-label={`Name for ${outcome.parsed.fileName}`}
          />
        </label>
      ) : (
        <span>{inputs.nicknames.get(key) || suggestedName(outcome)}</span>
      )}
      <span>{formatPeriodLabel(outcome.period)}</span>
      {summary.paymentDueDateISO && (
        <span>due {formatDateLabel(summary.paymentDueDateISO)}</span>
      )}
      <span>{outcome.parsed.transactions.length} txns</span>
      <TotalsWarning
        summary={summary}
        transactions={outcome.parsed.transactions}
        skippedRows={outcome.parsed.warnings.length}
      />
      {asksDueDay && (
        <label>
          Due day of month
          {dueDay !== undefined && !isValidDueDay(dueDay) && (
            <span className="error-text" role="alert">
              {' '}
              Enter a day from 1 to 31
            </span>
          )}
          <input
            type="number"
            min={1}
            max={31}
            value={dueDay ?? ''}
            onChange={(e) =>
              onDueDay(
                key,
                e.target.value === '' ? null : Number(e.target.value),
              )
            }
          />
        </label>
      )}
    </>
  );
}

export default ImportReview;
