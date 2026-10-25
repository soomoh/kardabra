import { useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { describeDbError, useDb, useReportError } from '../db/DbProvider';
import PasswordStep from './PasswordStep';
import ImportReview from './ImportReview';
import { useDataVersion } from '../context/DataVersionContext';
import { getAllCards, getAllStatements } from '../db/db';
import { planImport, type ParseResult, type FileOutcome } from '../import/plan';
import { commitImport, type CommitUserInput } from '../import/commit';
import { withSuggestedNames } from '../import/review';
import {
  readStatementFiles,
  skippedLockedResults,
  unlockFiles,
  type InputFile,
  type UnlockInput,
} from '../import/read';
import { readPdfInBrowser } from '../import/browserPdf';
import type { View } from '../App';

interface ImportPageProps {
  setView: (view: View) => void;
}

/**
 * The page's state as one discriminated union, so illegal combinations
 * (committing with no plan, an error with no plan beside it) can't be
 * represented. A failed commit returns to 'planned' with `commitError`
 * set: the user lands back on the plan they were looking at.
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

  /** `null` (the box was emptied) clears the answer rather than storing
   * `Number('')`, i.e. 0. */
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

  const { results, outcomes, inputs } = state;
  return (
    <ImportReview
      outcomes={outcomes}
      inputs={inputs}
      committing={state.stage === 'committing'}
      commitError={state.stage === 'planned' ? state.commitError : undefined}
      diagnostics={diagnostics}
      dropzone={dropzone}
      onNickname={updateNickname}
      onDueDay={updateDueDay}
      onStartOver={() => setState({ stage: 'idle' })}
      onCommit={() =>
        void handleCommit(results, outcomes, inputs).catch(reportError)
      }
    />
  );
}

export default ImportPage;
