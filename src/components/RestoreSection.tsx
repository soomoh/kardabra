import { useEffect, useRef, useState } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { useDataVersion } from '../context/DataVersionContext';
import {
  checkBackupFile,
  loadPassphrase,
  readBackupFile,
  restoreBackup,
  type OpenedBackup,
} from '../backup/backup';
import type { BackupData } from '../backup/payload';
import { formatDateLabel } from '../lib/dates';
import { announceDataReplaced } from '../lib/erase';
import { plural } from '../lib/plural';

type Step =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'ask'; file: File; wrong: boolean }
  | { kind: 'confirm'; data: BackupData; passphrase: string }
  | { kind: 'restoring'; data: BackupData; passphrase: string }
  | { kind: 'done'; data: BackupData };

/** A backup's creation time as the user's own calendar day ("2 Nov"). */
function madeOn(createdAt: string): string {
  const d = new Date(createdAt);
  const local = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
  return formatDateLabel(local);
}

/** The first problem, in plain words, with what to do next. */
function problemText(opened: Exclude<OpenedBackup, { ok: true }>): string {
  switch (opened.problem) {
    case 'too-big':
      return 'This file is too big to be a Kardabra backup. Choose the file Kardabra downloaded when you made the backup.';
    case 'not-a-backup':
      return 'This file isn’t a Kardabra backup. Choose the file Kardabra downloaded when you made the backup.';
    case 'newer':
      return 'This backup was made by a newer version of Kardabra. Reload this page to update Kardabra, then try again.';
    case 'wrong-passphrase':
      return 'That passphrase doesn’t open this backup. Check the five words for typos.';
    case 'damaged': {
      const detail = opened.detail[0].toLowerCase() + opened.detail.slice(1);
      return `This backup can’t be restored: ${detail}. Nothing was changed.`;
    }
  }
}

function summary(counts: { cards: number; statements: number }): string {
  return `${plural(counts.cards, 'card')} and ${plural(counts.statements, 'statement')}`;
}

function backupCounts(data: BackupData) {
  return { cards: data.cards.length, statements: data.statements.length };
}

/** Pick a backup file, open it, confirm, replace everything. */
function RestoreSection({
  current,
}: {
  /** What's stored now, for the confirm step; null while counting. */
  current: { cards: number; statements: number } | null;
}) {
  const db = useDb();
  const reportError = useReportError();
  const { bump } = useDataVersion();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const doneNote = useRef<HTMLParagraphElement>(null);
  // Where focus goes once the next step has rendered: the control that
  // had it (Cancel, Replace) is gone by then.
  const focusNext = useRef<'choose' | 'done' | null>(null);
  useEffect(() => {
    if (focusNext.current === 'choose') chooseButton.current?.focus();
    if (focusNext.current === 'done') doneNote.current?.focus();
    focusNext.current = null;
  }, [step]);

  function reset() {
    setStep({ kind: 'idle' });
    setTyped('');
    focusNext.current = 'choose';
  }

  /** Try `passphrase`; on success go to the confirm step. */
  async function tryOpen(file: File, passphrase: string, typedByUser: boolean) {
    const opened = await readBackupFile(file, passphrase);
    if (opened.ok) {
      setStep({ kind: 'confirm', data: opened.data, passphrase });
      return;
    }
    if (opened.problem === 'wrong-passphrase') {
      setStep({ kind: 'ask', file, wrong: typedByUser });
      return;
    }
    setProblem(problemText(opened));
    focusNext.current = 'choose';
    setStep({ kind: 'idle' });
  }

  async function chooseFile(file: File) {
    setProblem(null);
    setTyped('');
    setStep({ kind: 'opening' });
    try {
      const unopenable = await checkBackupFile(file);
      if (unopenable !== null) {
        setProblem(problemText({ ok: false, problem: unopenable }));
        focusNext.current = 'choose';
        setStep({ kind: 'idle' });
        return;
      }
      // The device's own passphrase opens its own backups without asking.
      const remembered = await loadPassphrase(db).catch(() => null);
      if (remembered === null) setStep({ kind: 'ask', file, wrong: false });
      else await tryOpen(file, remembered, false);
    } catch (error) {
      setStep({ kind: 'idle' });
      throw error;
    }
  }

  async function submitPassphrase(file: File) {
    if (typed.trim() === '') return;
    setStep({ kind: 'opening' });
    try {
      await tryOpen(file, typed, true);
    } catch (error) {
      setStep({ kind: 'ask', file, wrong: false });
      throw error;
    }
  }

  async function restore(data: BackupData, passphrase: string) {
    setStep({ kind: 'restoring', data, passphrase });
    try {
      await restoreBackup(db, data, passphrase);
    } catch (error) {
      setStep({ kind: 'confirm', data, passphrase });
      throw error;
    }
    announceDataReplaced();
    bump();
    setTyped('');
    setStep({ kind: 'done', data });
    focusNext.current = 'done';
  }

  // Null counts (still loading) are "unknown", never "nothing here".
  const replaces =
    current === null
      ? 'It replaces everything on this device,'
      : current.cards + current.statements > 0
        ? `It replaces the ${summary(current)} on this device,`
        : null;

  return (
    <section>
      <h2>Restore from a backup</h2>
      <p>
        Restoring replaces everything on this device with what’s in the backup.
      </p>

      {step.kind === 'ask' && (
        <form
          className="password-form callout"
          onSubmit={(event) => {
            event.preventDefault();
            void submitPassphrase(step.file).catch(reportError);
          }}
        >
          <p>Enter the passphrase for {step.file.name}.</p>
          <label htmlFor="backup-passphrase">
            Backup passphrase
            <input
              id="backup-passphrase"
              type="text"
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={typed}
              aria-invalid={step.wrong}
              aria-describedby={step.wrong ? 'passphrase-error' : undefined}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          {step.wrong && (
            <p id="passphrase-error" className="error-text" role="alert">
              {problemText({ ok: false, problem: 'wrong-passphrase' })}
            </p>
          )}
          <div className="import-actions">
            <button type="submit" className="primary">
              Open backup
            </button>
            <button type="button" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {(step.kind === 'confirm' || step.kind === 'restoring') && (
        <div className="delete-confirm">
          <p id="restore-warning">
            This backup from {madeOn(step.data.createdAt)} has{' '}
            {summary(backupCounts(step.data))}.{' '}
            {replaces === null
              ? 'Nothing is stored on this device yet.'
              : `${replaces} including names, due days and bills marked paid. There is no undo.`}
          </p>
          {/* Always present, so "Restoring…" is announced. */}
          <p role="status" className="visually-hidden">
            {step.kind === 'restoring' ? 'Restoring…' : ''}
          </p>
          <div className="import-actions">
            <button
              className="danger"
              aria-describedby="restore-warning"
              disabled={step.kind === 'restoring'}
              onClick={() =>
                step.kind === 'confirm' &&
                void restore(step.data, step.passphrase).catch(reportError)
              }
            >
              {step.kind === 'restoring' ? 'Restoring…' : 'Replace with backup'}
            </button>
            {step.kind === 'confirm' && (
              <button
                autoFocus
                aria-describedby="restore-warning"
                onClick={reset}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {step.kind === 'done' && (
        <p ref={doneNote} tabIndex={-1} role="status">
          Restored {summary(backupCounts(step.data))} from the backup of{' '}
          {madeOn(step.data.createdAt)}.
        </p>
      )}

      {problem && (
        <p className="error-text" role="alert">
          {problem}
        </p>
      )}

      {(step.kind === 'idle' ||
        step.kind === 'opening' ||
        step.kind === 'done') && (
        <div className="import-actions">
          <button
            ref={chooseButton}
            type="button"
            disabled={step.kind === 'opening'}
            onClick={() => fileInput.current?.click()}
          >
            {step.kind === 'opening' ? 'Opening…' : 'Choose backup file'}
          </button>
          <input
            ref={fileInput}
            id="backup-file-input"
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so choosing the same file again still fires.
              event.target.value = '';
              if (file) void chooseFile(file).catch(reportError);
            }}
          />
        </div>
      )}
    </section>
  );
}

export default RestoreSection;
