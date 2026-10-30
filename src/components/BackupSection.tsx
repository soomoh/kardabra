import { useEffect, useRef, useState } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { useDataVersion } from '../context/DataVersionContext';
import {
  backupFileName,
  loadPassphrase,
  makeBackup,
  passphraseForBackup,
  rememberPassphrase,
  UnrestorableBackup,
} from '../backup/backup';
import { generatePassphrase } from '../backup/passphrase';
import { useReturnFocus } from './useReturnFocus';

/** The passphrase, large and selectable, with a Copy button where the
 * browser allows one. */
function PassphraseBox({
  passphrase,
  id,
}: {
  passphrase: string;
  id?: string;
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const canCopy = typeof navigator.clipboard?.writeText === 'function';
  return (
    <div
      id={id}
      className="passphrase-row"
      role="group"
      aria-label="Backup passphrase"
    >
      <p className="passphrase">{passphrase}</p>
      {canCopy && (
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(passphrase).then(
              () => setCopy('copied'),
              () => setCopy('failed'),
            )
          }
        >
          Copy passphrase
        </button>
      )}
      {/* Always present, so the result is announced when it lands. */}
      <p role="status" className="muted copy-status">
        {copy === 'copied'
          ? 'Copied.'
          : copy === 'failed'
            ? 'Couldn’t copy. Select the words and copy them instead.'
            : ''}
      </p>
    </div>
  );
}

const KEEP_IT_SAFE =
  'Keep it somewhere safe, like a password manager. Kardabra can’t recover a lost passphrase: you’d have to import your statements again.';

/** What to tell the user after a backup or a passphrase change. Each
 * carries its own passphrase, so a later restore (which may bring another
 * one) can't put the wrong words beside a file. */
type News =
  | { kind: 'made'; fileName: string; newPassphrase?: string }
  | { kind: 'changed'; passphrase: string };

/** Download an encrypted backup; see and change the passphrase. */
function BackupSection({
  hasData,
}: {
  /** Null while the counts are still loading. */
  hasData: boolean | null;
}) {
  const db = useDb();
  const reportError = useReportError();
  // A restore can bring a passphrase to a device that had none.
  const { version } = useDataVersion();
  // undefined while loading; null when no backup has been made here yet.
  const [remembered, setRemembered] = useState<string | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [news, setNews] = useState<News>();
  // The self-check refused: the first problem, in plain words.
  const [problem, setProblem] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);
  const [confirmingChange, setConfirmingChange] = useState(false);
  const changeButton = useReturnFocus<HTMLButtonElement>(confirmingChange);
  const newsBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadPassphrase(db).then(
      (p) => !cancelled && setRemembered(p),
      (error: unknown) => {
        if (cancelled) return;
        setRemembered(null);
        reportError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [db, version, reportError]);

  // Focus follows the news once it has rendered (a disabled, then
  // re-enabled, button would otherwise leave focus on the page).
  useEffect(() => {
    if (news) newsBox.current?.focus();
  }, [news]);

  async function download() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const { passphrase, isNew } = await passphraseForBackup(db);
      let text: string;
      try {
        text = await makeBackup(db, passphrase);
      } catch (error) {
        if (!(error instanceof UnrestorableBackup)) throw error;
        const detail = error.message[0].toLowerCase() + error.message.slice(1);
        setProblem(
          `Kardabra couldn’t make a backup it could restore: ${detail}. Nothing was downloaded.`,
        );
        return;
      }
      const fileName = backupFileName();
      const url = URL.createObjectURL(
        new Blob([text], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      // Long enough for the browser to take even a large file.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setRemembered(passphrase);
      setNews({
        kind: 'made',
        fileName,
        newPassphrase: isNew ? passphrase : undefined,
      });
      setShowing(false);
    } finally {
      setBusy(false);
    }
  }

  async function changePassphrase() {
    if (busy) return;
    setBusy(true);
    try {
      const next = generatePassphrase();
      await rememberPassphrase(db, next);
      setRemembered(next);
      setConfirmingChange(false);
      setShowing(false);
      setNews({ kind: 'changed', passphrase: next });
    } finally {
      setBusy(false);
    }
  }

  // While the passphrase is on screen in the news, the controls to show
  // or change it would only repeat it.
  const newsShowsPassphrase =
    news?.kind === 'changed' ||
    (news?.kind === 'made' && news.newPassphrase !== undefined);

  return (
    <section>
      <h2>Back up your data</h2>
      <p>
        Make an encrypted backup to restore from or move to another device. PDF
        unlock passwords encrypted and saved on this device will not be backed
        up.
      </p>

      {news?.kind === 'made' && (
        <div ref={newsBox} tabIndex={-1} className="backup-news">
          <p>
            Your backup file is <strong>{news.fileName}</strong>.{' '}
            {news.newPassphrase !== undefined
              ? 'To restore it, you’ll need this passphrase:'
              : 'It opens with your backup passphrase.'}
          </p>
          {news.newPassphrase !== undefined && (
            <>
              <PassphraseBox passphrase={news.newPassphrase} />
              <p>{KEEP_IT_SAFE}</p>
            </>
          )}
        </div>
      )}
      {news?.kind === 'changed' && (
        <div ref={newsBox} tabIndex={-1} className="backup-news">
          <p>
            New backups will need this passphrase. Backups you’ve already made
            still open with the old one.
          </p>
          <PassphraseBox passphrase={news.passphrase} />
          <p>{KEEP_IT_SAFE}</p>
        </div>
      )}

      {hasData === true && (
        <div className="import-actions">
          <button
            className="primary"
            disabled={busy}
            onClick={() => void download().catch(reportError)}
          >
            {busy ? 'Making backup…' : 'Download backup'}
          </button>
        </div>
      )}
      {hasData === false && <p className="muted">Nothing to back up yet.</p>}
      {problem && (
        <p className="error-text" role="alert">
          {problem}
        </p>
      )}

      {remembered && !newsShowsPassphrase && (
        <>
          {confirmingChange ? (
            <div className="delete-confirm">
              <p id="change-warning">
                Backups you’ve already made will still need the old passphrase.
                Only new backups use the new one.
              </p>
              <div className="import-actions">
                <button
                  aria-describedby="change-warning"
                  disabled={busy}
                  onClick={() => void changePassphrase().catch(reportError)}
                >
                  Make a new passphrase
                </button>
                <button
                  autoFocus
                  aria-describedby="change-warning"
                  onClick={() => setConfirmingChange(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="import-actions">
              <button
                aria-expanded={showing}
                aria-controls="shown-passphrase"
                onClick={() => setShowing(!showing)}
              >
                {showing ? 'Hide passphrase' : 'Show passphrase'}
              </button>
              <button
                ref={changeButton}
                onClick={() => setConfirmingChange(true)}
              >
                Change passphrase
              </button>
            </div>
          )}
          {/* After its button, so it follows the focus in reading order. */}
          {showing && !confirmingChange && (
            <PassphraseBox id="shown-passphrase" passphrase={remembered} />
          )}
        </>
      )}
    </section>
  );
}

export default BackupSection;
