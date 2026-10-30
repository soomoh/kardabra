import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { describeDbError, useDb, useReportError } from '../db/DbProvider';
import PasswordStep from './PasswordStep';
import ImportReview from './ImportReview';
import { useDataVersion } from '../context/DataVersionContext';
import { getAllCards, getAllStatements, getAllTransactions } from '../db/db';
import type { CardRecord } from '../db/schema';
import { planImport, type ParseResult, type FileOutcome } from '../import/plan';
import { commitImport, type CommitUserInput } from '../import/commit';
import { importedNotice, withSuggestedNames } from '../import/review';
import {
  readStatementFiles,
  MAX_FILE_BYTES,
  skippedLockedResults,
  tooLargeResult,
  unlockFiles,
  type InputFile,
  type UnlockInput,
} from '../import/read';
import { readPdfInBrowser } from '../import/browserPdf';
import { loadSavedPasswords, sealPasswords } from '../import/savedPasswords';
import type { Sealed } from '../lib/secretBox';
import type { View } from '../lib/route';
import { useDocumentTitle } from './useDocumentTitle';

interface ImportPageProps {
  navigate: (view: View, options?: { replace?: boolean }) => void;
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
      /** Passwords the user asked to remember, already encrypted. */
      sealedPasswords: Map<string, Sealed>;
      retry: boolean;
      unlocking: boolean;
    }
  | ({ stage: 'planned'; commitError?: string } & Plan)
  | ({ stage: 'committing' } & Plan);

/** A planned batch and everything the review needs to show and change it. */
interface Plan {
  results: ParseResult[];
  outcomes: FileOutcome[];
  inputs: CommitUserInput;
  /** The cards in the database when this plan was made (picker options). */
  cards: CardRecord[];
  /** File name → "Which card is this?" answer (card id or NEW_CARD). */
  assignments: Map<string, string>;
}

function ImportPage({ navigate }: ImportPageProps) {
  const db = useDb();
  const reportError = useReportError();
  const { bump } = useDataVersion();
  const [state, setState] = useState<ImportState>({ stage: 'idle' });
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Files read or unlocked so far, while a step is busy — outside the state
  // machine: it's display only and changes per file.
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  // Counts nested dragenter/dragleave pairs, which fire for every child the
  // pointer crosses; the zone is "over" while the count is above zero.
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const heading = {
    idle: 'Import statements',
    reading: 'Import statements',
    locked: 'Unlock your statements',
    planned: 'Review and import',
    committing: 'Review and import',
  }[state.stage];
  useDocumentTitle(heading);

  // Each step of the import is announced: focus moves to its heading when
  // the step changes (the first step is reached via the app's own focus
  // move to <main>).
  const shownHeading = useRef(heading);
  useEffect(() => {
    if (shownHeading.current === heading) return;
    shownHeading.current = heading;
    headingRef.current?.focus();
  }, [heading]);
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
      // Checked on the size the browser reports, before reading anything.
      if (file.size > MAX_FILE_BYTES) {
        unreadable.push(tooLargeResult(file.name));
        continue;
      }
      try {
        inputs.push({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      } catch (error) {
        unreadable.push({ fileName: file.name, error });
      }
    }
    setProgress({ done: 0, total: inputs.length });
    const read = await readStatementFiles(
      inputs,
      readPdfInBrowser,
      (done, total) => setProgress({ done, total }),
    );
    setDiagnostics(read.diagnostics);
    const results = [...unreadable, ...read.results];
    // Remembered passwords first: only files none of them opens reach the
    // password step.
    let locked = read.locked;
    const saved = locked.length > 0 ? await loadSavedPasswords(db) : [];
    if (saved.length > 0) {
      const unlocked = await unlockFiles(
        locked,
        { passwords: saved },
        [],
        readPdfInBrowser,
        (done, total) => setProgress({ done, total }),
      );
      results.push(...unlocked.results);
      locked = unlocked.stillLocked;
    }
    setProgress(undefined);
    if (locked.length > 0) {
      setState({
        stage: 'locked',
        results,
        locked,
        passwordPatterns: new Map(),
        sealedPasswords: new Map(),
        retry: false,
        unlocking: false,
      });
      return;
    }
    await showPlan(results, new Map(), new Map());
  }

  async function handleUnlock(input: UnlockInput, remember: boolean) {
    if (state.stage !== 'locked') return;
    const locked = state;
    setState({ ...locked, unlocking: true });
    const knownPatterns = (await getAllCards(db)).flatMap((c) =>
      c.pdfPasswordPattern === undefined ? [] : [c.pdfPasswordPattern],
    );
    setProgress({ done: 0, total: locked.locked.length });
    const unlocked = await unlockFiles(
      locked.locked,
      input,
      knownPatterns,
      readPdfInBrowser,
      (done, total) => setProgress({ done, total }),
    );
    // Sealed straight away: the plaintext never reaches the page's state.
    // Consent is per attempt: passwords sealed on an earlier try stay sealed
    // even if the box is unticked on the retry. A failure here only loses
    // the remembering, never the unlocked files.
    let sealed = new Map<string, Sealed>();
    if (remember) {
      try {
        sealed = await sealPasswords(db, unlocked.passwords);
      } catch (error) {
        reportError(error);
      }
    }
    setProgress(undefined);
    const results = [...locked.results, ...unlocked.results];
    const passwordPatterns = new Map([
      ...locked.passwordPatterns,
      ...unlocked.patterns,
    ]);
    const sealedPasswords = new Map([...locked.sealedPasswords, ...sealed]);
    if (unlocked.stillLocked.length > 0) {
      setState({
        ...locked,
        results,
        locked: unlocked.stillLocked,
        passwordPatterns,
        sealedPasswords,
        retry: true,
        unlocking: false,
      });
      return;
    }
    await showPlan(results, passwordPatterns, sealedPasswords);
  }

  async function handleSkipLocked() {
    if (state.stage !== 'locked') return;
    await showPlan(
      [...state.results, ...skippedLockedResults(state.locked)],
      state.passwordPatterns,
      state.sealedPasswords,
    );
  }

  async function showPlan(
    results: ParseResult[],
    passwordPatterns: Map<string, string>,
    sealedPasswords: Map<string, Sealed>,
  ) {
    // "planImport with fresh DB state" — read cards/statements right
    // before planning, not from some earlier snapshot, so duplicate
    // detection sees whatever's actually in the database now.
    const assignments = new Map<string, string>();
    setState({
      stage: 'planned',
      results,
      assignments,
      ...(await planNow(results, assignments)),
      inputs: {
        nicknames: new Map(),
        dueDays: new Map(),
        passwordPatterns,
        sealedPasswords,
      },
    });
  }

  /** Plan against what is in the database right now. */
  async function planNow(
    results: ParseResult[],
    assignments: ReadonlyMap<string, string>,
  ): Promise<{ outcomes: FileOutcome[]; cards: CardRecord[] }> {
    const cards = await getAllCards(db);
    const outcomes = planImport(
      results,
      cards,
      await getAllStatements(db),
      assignments,
      await getAllTransactions(db),
    );
    return { outcomes, cards };
  }

  /** A failure mid-read must not leave the page stuck on "Reading…". */
  function recover(error: unknown) {
    setProgress(undefined);
    setState({ stage: 'idle' });
    reportError(error);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    void handleFiles(event.dataTransfer.files).catch(recover);
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files !== null)
      void handleFiles(event.target.files).catch(recover);
    event.target.value = ''; // allow re-selecting the same file(s) again
  }

  /** Drop one file from the batch and plan again, so in-batch duplicate
   * choices and question owners follow (answers already typed are kept —
   * they're keyed by card, not file). Removing the last file starts over. */
  async function handleRemove(fileName: string) {
    if (state.stage !== 'planned') return;
    const results = state.results.filter((r) => r.fileName !== fileName);
    if (results.length === 0) {
      setState({ stage: 'idle' });
      return;
    }
    const assignments = new Map(state.assignments);
    assignments.delete(fileName);
    const planned = await planNow(results, assignments);
    // Functional update: answers typed while the database was read stay.
    setState((current) =>
      current.stage === 'planned'
        ? {
            ...current,
            ...planned,
            results,
            assignments,
            commitError: undefined,
          }
        : current,
    );
  }

  /** "Which card is this?" answered (or changed): plan again so the file
   * joins that card — and becomes a duplicate if the card has the month. */
  async function handleAssign(fileName: string, choice: string) {
    if (state.stage !== 'planned') return;
    const assignments = new Map(state.assignments).set(fileName, choice);
    const planned = await planNow(state.results, assignments);
    setState((current) =>
      current.stage === 'planned'
        ? { ...current, ...planned, assignments }
        : current,
    );
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

  async function handleCommit(plan: Plan) {
    const { results, outcomes, inputs, assignments } = plan;
    setState({ stage: 'committing', ...plan });
    try {
      const result = await commitImport(
        db,
        outcomes,
        withSuggestedNames(outcomes, inputs),
      );
      bump();
      navigate({ name: 'dashboard', notice: importedNotice(result) });
    } catch (error) {
      // A commit is several writes, so a failure can leave some of them done
      // (a card created, a statement written). Re-plan against what is in the
      // database now, so retrying can't create a second copy of that card.
      bump();
      // If even reading the database fails now, keep the old plan rather
      // than leaving the page stuck on "Importing…".
      let replanned = { outcomes, cards: plan.cards };
      try {
        replanned = await planNow(results, assignments);
      } catch {
        /* keep the previous plan; the error below says what happened */
      }
      setState({
        stage: 'planned',
        ...plan,
        ...replanned,
        commitError: describeDbError(error),
      });
    }
  }

  const dropzone = (
    <div
      className={dragOver ? 'dropzone is-dragover' : 'dropzone'}
      onDrop={handleDrop}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={() => {
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragOver(false);
      }}
    >
      <p>{dragOver ? 'Drop to read them' : 'Drag statement files here, or'}</p>
      {/* A real button (keyboard-reachable) opening a hidden file input;
          a <label> for a display:none input can't take focus. */}
      <button type="button" onClick={() => fileInputRef.current?.click()}>
        Choose files
      </button>
      <input
        ref={fileInputRef}
        id="statement-file-input"
        type="file"
        multiple
        onChange={handleFileInputChange}
        hidden
      />
    </div>
  );

  const title = (
    <h1 ref={headingRef} tabIndex={-1} className="page-heading">
      {heading}
    </h1>
  );

  if (state.stage === 'idle') {
    return (
      <div>
        {title}
        {dropzone}
      </div>
    );
  }

  if (state.stage === 'reading') {
    return (
      <div>
        {title}
        <p role="status">
          {progress === undefined || progress.total < 2
            ? 'Reading files…'
            : `Reading ${progress.done} of ${progress.total} files…`}
        </p>
      </div>
    );
  }

  if (state.stage === 'locked') {
    return (
      <div>
        {title}
        <PasswordStep
          fileNames={state.locked.map((f) => f.name)}
          retry={state.retry}
          unlocking={state.unlocking}
          progress={progress}
          onUnlock={(input, remember) =>
            void handleUnlock(input, remember).catch(recover)
          }
          onSkip={() => void handleSkipLocked().catch(recover)}
        />
      </div>
    );
  }

  const plan: Plan = state;
  return (
    <div>
      {title}
      <ImportReview
        outcomes={state.outcomes}
        inputs={state.inputs}
        cards={state.cards}
        assignments={state.assignments}
        committing={state.stage === 'committing'}
        commitError={state.stage === 'planned' ? state.commitError : undefined}
        diagnostics={diagnostics}
        onNickname={updateNickname}
        onDueDay={updateDueDay}
        onAssign={(fileName, choice) =>
          void handleAssign(fileName, choice).catch(reportError)
        }
        onRemove={(fileName) => void handleRemove(fileName).catch(reportError)}
        onCancel={() => setState({ stage: 'idle' })}
        onCommit={() => void handleCommit(plan).catch(reportError)}
      />
    </div>
  );
}

export default ImportPage;
