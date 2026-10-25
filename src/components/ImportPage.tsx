import { useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { describeDbError, useDb, useReportError } from '../db/DbProvider';
import TotalsWarning from './TotalsWarning';
import PasswordStep from './PasswordStep';
import { useDataVersion } from '../context/DataVersionContext';
import { getAllCards, getAllStatements } from '../db/db';
import type { StatementErrorKind } from '../parser';
import {
  planImport,
  commitImport,
  cardInputKey,
  type ParseResult,
  type FileOutcome,
  type CommitUserInput,
} from '../import/plan';
import { buildFeedbackReport, type FeedbackEntry } from '../import/feedback';
import {
  readStatementFiles,
  skippedLockedResults,
  unlockFiles,
  type InputFile,
  type UnlockInput,
} from '../import/read';
import { readPdfInBrowser } from '../import/browserPdf';
import {
  formatDateLabel,
  formatPeriodLabel,
  isValidDueDay,
} from '../lib/dates';
import type { View } from '../App';

interface ImportPageProps {
  setView: (view: View) => void;
}

// Rejection kinds that are a CORRECT classification, not a failure to read the
// file — these are skipped cleanly and never prompt a "help us support this"
// report. Everything else the parser couldn't read (no table, unknown dates, a
// genuine error) is reportable.
const UNDERSTOOD_REJECTIONS: StatementErrorKind[] = [
  'savings-statement',
  'pdf-locked',
];

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
  | { stage: 'reading' }
  | {
      // Some PDFs need a password: asked once for the whole batch.
      stage: 'locked';
      results: ParseResult[];
      locked: InputFile[];
      passwordPatterns: Map<string, string>;
      retry: boolean;
      unlocking: boolean;
    }
  | {
      stage: 'planned';
      results: ParseResult[];
      outcomes: FileOutcome[];
      inputs: CommitUserInput;
      commitError?: string;
    }
  | {
      stage: 'committing';
      results: ParseResult[];
      outcomes: FileOutcome[];
      inputs: CommitUserInput;
    };

/** An outcome's own file name, regardless of which variant it is —
 * 'new-statement' carries it nested inside `parsed`, the other three
 * variants hoist it to the top level (see plan.ts's header comment on
 * why). */
function outcomeFileName(outcome: FileOutcome): string {
  return outcome.kind === 'new-statement'
    ? outcome.parsed.fileName
    : outcome.fileName;
}

/** Every due day the plan requires has been supplied (a card name left
 * blank falls back to the suggestion — see withSuggestedNames). Drives the
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
    const dueDay = inputs.dueDays.get(key);
    if (
      outcome.needsDueDay &&
      (dueDay === undefined || !isValidDueDay(dueDay))
    ) {
      return false;
    }
  }
  return true;
}

/** The card-name box shows the suggestion as a placeholder, so a name left
 * blank means "use the suggestion". */
function suggestedName(outcome: FileOutcome): string | undefined {
  return outcome.kind === 'new-statement' && outcome.cardRef.kind === 'new'
    ? outcome.cardRef.suggestedNickname
    : undefined;
}

function withSuggestedNames(
  outcomes: FileOutcome[],
  inputs: CommitUserInput,
): CommitUserInput {
  const nicknames = new Map(inputs.nicknames);
  for (const outcome of outcomes) {
    const suggestion = suggestedName(outcome);
    if (outcome.kind !== 'new-statement' || suggestion === undefined) continue;
    const key = cardInputKey(outcome.cardRef, outcome.parsed.fileName);
    if ((nicknames.get(key) ?? '').trim() === '')
      nicknames.set(key, suggestion);
  }
  return { ...inputs, nicknames };
}

function ImportPage({ setView }: ImportPageProps) {
  const db = useDb();
  const reportError = useReportError();
  const { bump } = useDataVersion();
  const [state, setState] = useState<ImportState>({ stage: 'idle' });
  // Number-masked diagnostics for files that couldn't be parsed, keyed by file
  // name — kept beside the plan (not in the state machine) since they're only
  // read when building a report. Overwritten on each new batch.
  const [diagnostics, setDiagnostics] = useState<Map<string, string>>(
    new Map(),
  );

  async function handleFiles(files: FileList) {
    setState({ stage: 'reading' });
    const inputs: InputFile[] = [];
    const unreadable: ParseResult[] = [];
    for (const file of Array.from(files)) {
      try {
        inputs.push({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      } catch (error) {
        unreadable.push({ fileName: file.name, error });
      }
    }
    const read = await readStatementFiles(inputs, readPdfInBrowser);
    setDiagnostics(read.diagnostics);
    const results = [...unreadable, ...read.results];
    if (read.locked.length > 0) {
      setState({
        stage: 'locked',
        results,
        locked: read.locked,
        passwordPatterns: new Map(),
        retry: false,
        unlocking: false,
      });
      return;
    }
    await showPlan(results, new Map());
  }

  async function handleUnlock(input: UnlockInput) {
    if (state.stage !== 'locked') return;
    const locked = state;
    setState({ ...locked, unlocking: true });
    const knownPatterns = (await getAllCards(db)).flatMap((c) =>
      c.pdfPasswordPattern === undefined ? [] : [c.pdfPasswordPattern],
    );
    const unlocked = await unlockFiles(
      locked.locked,
      input,
      knownPatterns,
      readPdfInBrowser,
    );
    const results = [...locked.results, ...unlocked.results];
    const passwordPatterns = new Map([
      ...locked.passwordPatterns,
      ...unlocked.patterns,
    ]);
    if (unlocked.stillLocked.length > 0) {
      setState({
        ...locked,
        results,
        locked: unlocked.stillLocked,
        passwordPatterns,
        retry: true,
        unlocking: false,
      });
      return;
    }
    await showPlan(results, passwordPatterns);
  }

  async function handleSkipLocked() {
    if (state.stage !== 'locked') return;
    await showPlan(
      [...state.results, ...skippedLockedResults(state.locked)],
      state.passwordPatterns,
    );
  }

  async function showPlan(
    results: ParseResult[],
    passwordPatterns: Map<string, string>,
  ) {
    // "planImport with fresh DB state" — read cards/statements right
    // before planning, not from some earlier snapshot, so duplicate
    // detection sees whatever's actually in the database now.
    const existingCards = await getAllCards(db);
    const existingStatements = await getAllStatements(db);
    const outcomes = planImport(results, existingCards, existingStatements);
    setState({
      stage: 'planned',
      results,
      outcomes,
      inputs: { nicknames: new Map(), dueDays: new Map(), passwordPatterns },
    });
  }

  /** A failure mid-read must not leave the page stuck on "Reading…". */
  function recover(error: unknown) {
    setState({ stage: 'idle' });
    reportError(error);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    void handleFiles(event.dataTransfer.files).catch(recover);
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files !== null)
      void handleFiles(event.target.files).catch(recover);
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
    results: ParseResult[],
    outcomes: FileOutcome[],
    inputs: CommitUserInput,
  ) {
    setState({ stage: 'committing', results, outcomes, inputs });
    try {
      await commitImport(db, outcomes, withSuggestedNames(outcomes, inputs));
      bump();
      setView({ name: 'dashboard' });
    } catch (error) {
      // A commit is several writes, so a failure can leave some of them done
      // (a card created, a statement written). Re-plan against what is in the
      // database now, so retrying can't create a second copy of that card.
      bump();
      // If even reading the database fails now, keep the old plan rather
      // than leaving the page stuck on "Importing…".
      let replanned = outcomes;
      try {
        replanned = planImport(
          results,
          await getAllCards(db),
          await getAllStatements(db),
        );
      } catch {
        /* keep the previous plan; the error below says what happened */
      }
      setState({
        stage: 'planned',
        results,
        outcomes: replanned,
        inputs,
        commitError: describeDbError(error),
      });
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

  if (state.stage === 'reading') {
    return (
      <div>
        <h1>Import statements</h1>
        <p role="status">Reading files…</p>
      </div>
    );
  }

  if (state.stage === 'locked') {
    return (
      <div>
        <h1>Import statements</h1>
        <PasswordStep
          fileNames={state.locked.map((f) => f.name)}
          retry={state.retry}
          unlocking={state.unlocking}
          onUnlock={(input) => void handleUnlock(input).catch(recover)}
          onSkip={() => void handleSkipLocked().catch(recover)}
        />
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

  // Only files the parser genuinely couldn't READ become a report. A cleanly
  // classified skip (a savings statement, say) is the parser succeeding, not
  // failing, so it never appears here. Each entry carries a number-masked
  // diagnostic; the report is built and downloaded on the device — nothing is
  // uploaded.
  const feedbackEntries: FeedbackEntry[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'failed') {
      feedbackEntries.push({
        fileName: outcome.fileName,
        kind: 'failed',
        detail: outcome.message,
        diagnostic: diagnostics.get(outcome.fileName),
      });
    } else if (
      outcome.kind === 'rejected' &&
      !UNDERSTOOD_REJECTIONS.includes(outcome.errorKind)
    ) {
      feedbackEntries.push({
        fileName: outcome.fileName,
        kind: 'rejected',
        errorKind: outcome.errorKind,
        detail: outcome.advice,
        diagnostic: diagnostics.get(outcome.fileName),
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
    link.download = 'kardabra-unreadable-statements.txt';
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
                          placeholder={suggestedName(outcome)}
                          aria-label={`Name for ${outcomeFileName(outcome)}`}
                        />
                      </label>
                    ) : (
                      <span>
                        {inputs.nicknames.get(key) || suggestedName(outcome)}
                      </span>
                    )}
                    <span>{formatPeriodLabel(outcome.period)}</span>
                    {outcome.parsed.summary.paymentDueDateISO && (
                      <span>
                        due{' '}
                        {formatDateLabel(
                          outcome.parsed.summary.paymentDueDateISO,
                        )}
                      </span>
                    )}
                    <span>{outcome.parsed.transactions.length} txns</span>
                    <TotalsWarning
                      summary={outcome.parsed.summary}
                      transactions={outcome.parsed.transactions}
                      skippedRows={outcome.parsed.warnings.length}
                    />
                    {showDueDayInput && (
                      <label>
                        Due day of month
                        {inputs.dueDays.has(key) &&
                          !isValidDueDay(inputs.dueDays.get(key)!) && (
                            <span className="error-text" role="alert">
                              {' '}
                              Enter a day from 1 to 31
                            </span>
                          )}
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
            Kardabra couldn't read{' '}
            {feedbackEntries.length === 1 ? 'one file' : 'some files'}. Download
            a local report to help add support — it captures the file's
            structure with numbers masked, stays on your device, and is yours to
            review before sharing.
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
          onClick={() =>
            void handleCommit(state.results, outcomes, inputs).catch(
              reportError,
            )
          }
          disabled={committing || !planIsComplete(outcomes, inputs)}
        >
          {committing ? 'Importing…' : 'Import'}
        </button>
      </div>
    </div>
  );
}

export default ImportPage;
