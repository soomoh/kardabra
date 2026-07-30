import { useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { useDb } from '../db/useDb';
import { useDataVersion } from '../context/DataVersionContext';
import { getAllCards, getAllStatements } from '../db/db';
import { parseStatement } from '../parser';
import {
  planImport,
  commitImport,
  cardInputKey,
  type ParseResult,
  type FileOutcome,
  type CommitUserInput,
} from '../import/plan';
import { buildFeedbackReport, type FeedbackEntry } from '../import/feedback';
import { formatINR } from '../lib/money';
import { formatPeriodLabel, formatDateLabel } from '../lib/dates';
import type { View } from '../App';

interface ImportPageProps {
  setView: (view: View) => void;
}

/**
 * The whole page's state as one discriminated union, not a pile of
 * booleans (`isPlanning`/`isCommitting`/`hasError` etc. all
 * independently settable, and therefore independently capable of
 * disagreeing with each other). A state machine makes the illegal
 * combinations — committing with no plan, an error with no plan to show
 * it next to — unrepresentable rather than just "shouldn't happen".
 *
 * `commitError` lives on the 'planned' variant rather than as a fourth
 * top-level stage: a failed commit lands the user back on the same plan
 * they were looking at, with a message added, not a different screen.
 */
type ImportState =
  | { stage: 'idle' }
  | {
      stage: 'planned';
      outcomes: FileOutcome[];
      inputs: CommitUserInput;
      commitError?: string;
    }
  | { stage: 'committing'; outcomes: FileOutcome[]; inputs: CommitUserInput };

/** An outcome's own file name, regardless of which variant it is —
 * 'new-statement' carries it nested inside `parsed`, the other three
 * variants hoist it to the top level (see plan.ts's header comment on
 * why). */
function outcomeFileName(outcome: FileOutcome): string {
  return outcome.kind === 'new-statement'
    ? outcome.parsed.fileName
    : outcome.fileName;
}

/** Every nickname/dueDay the plan requires has been supplied. Drives the
 * Import button's disabled state — computed fresh from `outcomes` and
 * `inputs` rather than tracked as its own boolean, so it can never drift
 * out of sync with what's actually been typed. */
function planIsComplete(
  outcomes: FileOutcome[],
  inputs: CommitUserInput,
): boolean {
  for (const outcome of outcomes) {
    if (outcome.kind !== 'new-statement') continue;
    const key = cardInputKey(outcome.cardRef, outcome.parsed.fileName);

    if (outcome.cardRef.kind === 'new') {
      const nickname = inputs.nicknames.get(key);
      if (nickname === undefined || nickname.trim() === '') return false;
    }
    if (outcome.needsDueDay && inputs.dueDays.get(key) === undefined) {
      return false;
    }
  }
  return true;
}

function ImportPage({ setView }: ImportPageProps) {
  const db = useDb();
  const { bump } = useDataVersion();
  const [state, setState] = useState<ImportState>({ stage: 'idle' });

  async function handleFiles(files: FileList) {
    if (db === null) return;

    const results: ParseResult[] = [];
    for (const file of Array.from(files)) {
      // Error containment at the file boundary (see plan.ts's header
      // comment): one bad file becomes one 'rejected'/'failed' row in the
      // plan, never an exception that aborts the whole batch.
      try {
        const parsed = await parseStatement(file);
        results.push({ fileName: file.name, parsed });
      } catch (error) {
        results.push({ fileName: file.name, error });
      }
    }

    // "planImport with fresh DB state" — read cards/statements right
    // before planning, not from some earlier snapshot, so duplicate
    // detection sees whatever's actually in the database now.
    const existingCards = await getAllCards(db);
    const existingStatements = await getAllStatements(db);
    const outcomes = planImport(results, existingCards, existingStatements);

    // Prefill: one nickname entry per unique cardInputKey, defaulted to
    // the plan's suggestion, so the input renders non-empty and the
    // completeness check above starts out satisfied for cards the user
    // doesn't feel like renaming.
    const nicknames = new Map<string, string>();
    for (const outcome of outcomes) {
      if (outcome.kind !== 'new-statement' || outcome.cardRef.kind !== 'new') {
        continue;
      }
      const key = cardInputKey(outcome.cardRef, outcome.parsed.fileName);
      if (!nicknames.has(key)) {
        nicknames.set(key, outcome.cardRef.suggestedNickname);
      }
    }

    setState({
      stage: 'planned',
      outcomes,
      inputs: { nicknames, dueDays: new Map() },
    });
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    void handleFiles(event.dataTransfer.files);
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files !== null) void handleFiles(event.target.files);
    event.target.value = ''; // allow re-selecting the same file(s) again
  }

  function updateNickname(key: string, value: string) {
    if (state.stage !== 'planned') return;
    const nicknames = new Map(state.inputs.nicknames);
    nicknames.set(key, value);
    setState({ ...state, inputs: { ...state.inputs, nicknames } });
  }

  /** `null` clears the entry (the input was emptied) rather than storing
   * it as `0` — `Number('')` is `0`, and 0 is a real day-of-month
   * (well, isn't, but the point stands for any digit the user hasn't
   * finished typing), not "no answer yet". Same sentinel-vs-value
   * distinction as CardRecord.dueDay's own comment in schema.ts. */
  function updateDueDay(key: string, value: number | null) {
    if (state.stage !== 'planned') return;
    const dueDays = new Map(state.inputs.dueDays);
    if (value === null) {
      dueDays.delete(key);
    } else {
      dueDays.set(key, value);
    }
    setState({ ...state, inputs: { ...state.inputs, dueDays } });
  }

  async function handleCommit(
    outcomes: FileOutcome[],
    inputs: CommitUserInput,
  ) {
    if (db === null) return;
    setState({ stage: 'committing', outcomes, inputs });
    try {
      await commitImport(db, outcomes, inputs);
      bump();
      setView({ name: 'dashboard' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState({ stage: 'planned', outcomes, inputs, commitError: message });
    }
  }

  const dropzone = (
    <div
      className="dropzone"
      onDrop={handleDrop}
      onDragOver={(event) => event.preventDefault()}
    >
      <p>Drag statement files here, or</p>
      <label className="button-like" htmlFor="statement-file-input">
        Choose files
      </label>
      <input
        id="statement-file-input"
        type="file"
        multiple
        onChange={handleFileInputChange}
        style={{ display: 'none' }}
      />
    </div>
  );

  if (state.stage === 'idle') {
    return (
      <div>
        <h1>Import statements</h1>
        {dropzone}
      </div>
    );
  }

  const { outcomes, inputs } = state;
  const newStatements = outcomes.filter((o) => o.kind === 'new-statement');
  const duplicates = outcomes.filter((o) => o.kind === 'duplicate');
  const rejected = outcomes.filter((o) => o.kind === 'rejected');
  const failed = outcomes.filter((o) => o.kind === 'failed');

  // Tracks which cardInputKeys have already had their <input> rendered in
  // this pass, so two files that share a new card (planImport's batch
  // dedupe — see cardInputKey's own comment) render exactly one nickname
  // box and one due-day box between them, not one per file.
  const renderedNicknameKeys = new Set<string>();
  const renderedDueDayKeys = new Set<string>();

  const committing = state.stage === 'committing';

  // Files the parser couldn't use, turned into a local report the user can
  // share to get a new format supported. Built here, downloaded on the device
  // (Blob + object URL) — nothing is uploaded.
  const feedbackEntries: FeedbackEntry[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'rejected') {
      feedbackEntries.push({
        fileName: outcome.fileName,
        kind: 'rejected',
        errorKind: outcome.errorKind,
        detail: outcome.advice,
      });
    } else if (outcome.kind === 'failed') {
      feedbackEntries.push({
        fileName: outcome.fileName,
        kind: 'failed',
        detail: outcome.message,
      });
    }
  }

  function downloadReport() {
    const blob = new Blob([buildFeedbackReport(feedbackEntries)], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'kardabra-unrecognized-report.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Import statements</h1>
      {state.stage === 'planned' && dropzone}

      {newStatements.length > 0 && (
        <section>
          <h2>New statements</h2>
          <ul className="plan-list">
            {newStatements.map((outcome) => {
              if (outcome.kind !== 'new-statement') return null;
              const key = cardInputKey(
                outcome.cardRef,
                outcome.parsed.fileName,
              );
              const showNicknameInput =
                outcome.cardRef.kind === 'new' &&
                !renderedNicknameKeys.has(key);
              if (showNicknameInput) renderedNicknameKeys.add(key);
              const showDueDayInput =
                outcome.needsDueDay && !renderedDueDayKeys.has(key);
              if (showDueDayInput) renderedDueDayKeys.add(key);

              return (
                <li key={outcomeFileName(outcome)} className="plan-row">
                  <div className="plan-row-file">
                    {outcomeFileName(outcome)}
                  </div>
                  <div className="plan-row-details">
                    {outcome.cardRef.kind === 'existing' ? (
                      <span>{outcome.cardRef.nickname}</span>
                    ) : showNicknameInput ? (
                      // A visible "Name this card" label, not just a
                      // pre-filled box: the nickname is the ONLY thing that
                      // identifies this card on the dashboard (the tile
                      // shows no card number — see CardTile), so the
                      // import step makes naming it explicit.
                      <label className="nickname-field">
                        Name this card
                        <input
                          type="text"
                          value={inputs.nicknames.get(key) ?? ''}
                          onChange={(e) => updateNickname(key, e.target.value)}
                          placeholder="e.g. HDFC Regalia"
                          aria-label={`Name for ${outcomeFileName(outcome)}`}
                        />
                      </label>
                    ) : (
                      <span>{inputs.nicknames.get(key)}</span>
                    )}
                    <span>{formatPeriodLabel(outcome.period)}</span>
                    <span>{outcome.parsed.transactions.length} txns</span>
                    {outcome.parsed.summary.totalDue !== undefined && (
                      <span>{formatINR(outcome.parsed.summary.totalDue)}</span>
                    )}
                    {outcome.parsed.summary.paymentDueDateISO !== undefined && (
                      <span>
                        due{' '}
                        {formatDateLabel(
                          outcome.parsed.summary.paymentDueDateISO,
                        )}
                      </span>
                    )}
                    {showDueDayInput && (
                      <label>
                        Due day of month
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={inputs.dueDays.get(key) ?? ''}
                          onChange={(e) =>
                            updateDueDay(
                              key,
                              e.target.value === ''
                                ? null
                                : Number(e.target.value),
                            )
                          }
                        />
                      </label>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {duplicates.length > 0 && (
        <section>
          <h2>Already imported</h2>
          <ul className="plan-list">
            {duplicates.map((outcome) => {
              if (outcome.kind !== 'duplicate') return null;
              return (
                <li key={outcome.fileName} className="plan-row">
                  <div className="plan-row-file">{outcome.fileName}</div>
                  <div className="plan-row-details">
                    <span>
                      already imported ({outcome.existingTxnCount} txns) — this
                      file: {outcome.newTxnCount}
                    </span>
                    {outcome.supersedes && (
                      <span className="badge">will replace</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {rejected.length > 0 && (
        <section>
          <h2>Skipped</h2>
          <ul className="plan-list">
            {rejected.map((outcome) => {
              if (outcome.kind !== 'rejected') return null;
              return (
                <li key={outcome.fileName} className="plan-row">
                  <div className="plan-row-file">{outcome.fileName}</div>
                  <div className="plan-row-details">{outcome.advice}</div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {failed.length > 0 && (
        <section>
          <h2>Failed</h2>
          <ul className="plan-list">
            {failed.map((outcome) => {
              if (outcome.kind !== 'failed') return null;
              return (
                <li key={outcome.fileName} className="plan-row">
                  <div className="plan-row-file">{outcome.fileName}</div>
                  <div className="plan-row-details">{outcome.message}</div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {feedbackEntries.length > 0 && (
        <section>
          <p className="muted">
            Some files weren't recognized. Download a local report to help add
            support for their format — it lists only file names and the reason,
            never statement contents, and nothing leaves your device.
          </p>
          <button onClick={downloadReport}>Download report</button>
        </section>
      )}

      {state.stage === 'planned' && state.commitError !== undefined && (
        <p className="error-text">Import failed: {state.commitError}</p>
      )}

      <div className="import-actions">
        <button
          onClick={() => setState({ stage: 'idle' })}
          disabled={committing}
        >
          Start over
        </button>
        <button
          onClick={() => void handleCommit(outcomes, inputs)}
          disabled={committing || !planIsComplete(outcomes, inputs)}
        >
          {committing ? 'Importing…' : 'Import'}
        </button>
      </div>
    </div>
  );
}

export default ImportPage;
