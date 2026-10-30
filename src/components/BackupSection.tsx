import { useEffect, useRef, useState } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { useDataVersion } from '../context/DataVersionContext';
import {
  backupFileName,
  loadPassphrase,
  makeBackup,
  rememberFirstPassphrase,
  rememberPassphrase,
  UnrestorableBackup,
} from '../backup/backup';
import { generatePassphrase } from '../backup/passphrase';

/** The passphrase, large and selectable, with a Copy button where the
 * browser allows one. */
function PassphraseBox({ passphrase }: { passphrase: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const canCopy = typeof navigator.clipboard?.writeText === 'function';
  return (
    <div className="passphrase-row" role="group" aria-label="Backup passphrase">
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
      <p role="status" className="copy-status">
        {copy === 'copied'
          ? 'Copied.'
          : copy === 'failed'
            ? 'Couldn’t copy. Select the words and copy them instead.'
            : ''}
      </p>
    </div>
  );
}

/** A passphrase waiting for the user to save it. Nothing is stored or
 * downloaded until they say they have. `first`: the device's first
 * backup; `change`: replacing a passphrase (forgotten, or leaked). */
interface Offer {
  kind: 'first' | 'change';
  passphrase: string;
  /** Another tab stored a different first passphrase meanwhile; this is
   * that one, shown before any backup uses it. */
  replaced?: boolean;
}

type FocusTarget = 'offer' | 'made' | 'problem' | 'download' | 'change';

/** Download an encrypted backup; change the passphrase. The passphrase is
 * shown only when it's new, and nothing downloads until the user says
 * they've saved it: a backup whose passphrase was missed is no backup. */
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
  const [offer, setOffer] = useState<Offer | null>(null);
  const [madeFile, setMadeFile] = useState<string | null>(null);
  // The self-check refused: the first problem, in plain words.
  const [problem, setProblem] = useState<string | null>(null);
  const refs = {
    offer: useRef<HTMLDivElement>(null),
    made: useRef<HTMLDivElement>(null),
    problem: useRef<HTMLDivElement>(null),
    download: useRef<HTMLButtonElement>(null),
    change: useRef<HTMLButtonElement>(null),
  };
  // Where focus goes once the next state has rendered: the control that
  // had it has usually just gone.
  const focusNext = useRef<FocusTarget | null>(null);

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

  // Kept pending until its target has rendered (and isn't disabled), so
  // the order React renders state updates in can't drop it.
  useEffect(() => {
    if (focusNext.current === null) return;
    const target: HTMLElement | null = refs[focusNext.current].current;
    if (target === null || (target as HTMLButtonElement).disabled) return;
    target.focus();
    focusNext.current = null;
  });

  /** Make, check and hand over the file. `changed`: a new passphrase was
   * just stored, which a refusal must not leave unsaid. */
  async function download(passphrase: string, changed = false): Promise<void> {
    let text: string;
    try {
      text = await makeBackup(db, passphrase);
    } catch (error) {
      if (!(error instanceof UnrestorableBackup)) throw error;
      const detail = error.message[0].toLowerCase() + error.message.slice(1);
      focusNext.current = 'problem';
      setProblem(
        `Kardabra couldn’t make a backup it could restore: ${detail}. Nothing was downloaded.${changed ? ' Your new passphrase is saved and will be used for the next backup.' : ''}`,
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
    focusNext.current = 'made';
    setMadeFile(fileName);
  }

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  function clearNews() {
    setProblem(null);
    setMadeFile(null);
  }

  function startBackup() {
    clearNews();
    void run(async () => {
      // Read fresh: another tab may have made or changed it since this
      // page loaded, and a backup must use the device's current one.
      const current = await loadPassphrase(db);
      setRemembered(current);
      if (current !== null) {
        await download(current);
        return;
      }
      focusNext.current = 'offer';
      setOffer({ kind: 'first', passphrase: generatePassphrase() });
    }).catch(reportError);
  }

  function startChange() {
    clearNews();
    focusNext.current = 'offer';
    setOffer({ kind: 'change', passphrase: generatePassphrase() });
  }

  function cancelOffer() {
    focusNext.current = offer?.kind === 'change' ? 'change' : 'download';
    setOffer(null);
  }

  async function confirmOffer(current: Offer) {
    let passphrase = current.passphrase;
    if (current.kind === 'first') {
      passphrase = await rememberFirstPassphrase(db, current.passphrase);
      if (passphrase !== current.passphrase) {
        // Never back up under words the user hasn't seen.
        focusNext.current = 'offer';
        setOffer({ ...current, passphrase, replaced: true });
        return;
      }
    } else {
      await rememberPassphrase(db, passphrase);
    }
    setRemembered(passphrase);
    // The callout (with its "Making backup…" button) stays until the file
    // is made, so focus and the news have somewhere to be meanwhile.
    try {
      await download(passphrase, current.kind === 'change');
    } finally {
      setOffer(null);
    }
  }

  return (
    <section>
      <h2>Back up your data</h2>
      <p>
        Make an encrypted backup to restore from or move to another device. PDF
        unlock passwords encrypted and saved on this device will not be backed
        up.
      </p>

      {offer !== null ? (
        <div
          ref={refs.offer}
          tabIndex={-1}
          className="callout"
          role="group"
          aria-labelledby="offer-lead"
        >
          <p id="offer-lead">
            {offer.replaced
              ? 'This device already has a backup passphrase, so your backup will use it. Save this one instead.'
              : offer.kind === 'first'
                ? 'Save your backup passphrase before you download. You’ll need it to restore this backup.'
                : 'Here’s your new passphrase. Save it before you download a backup with it. Backups you’ve already made still open with the old one.'}
          </p>
          {/* Keyed, so "Copied." never sits beside words that weren't. */}
          <PassphraseBox key={offer.passphrase} passphrase={offer.passphrase} />
          <p className="callout-note">
            Keep it somewhere safe, like a password manager. Kardabra can’t
            recover a lost passphrase.
          </p>
          <div className="import-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(() => confirmOffer(offer)).catch(reportError)
              }
            >
              {busy ? 'Making backup…' : 'I’ve saved it, download backup'}
            </button>
            <button disabled={busy} onClick={cancelOffer}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {madeFile !== null && (
            <div
              ref={refs.made}
              tabIndex={-1}
              className="notice inline-notice"
              role="status"
            >
              <p>
                Your backup file is {madeFile}. It opens with your backup
                passphrase.
              </p>
            </div>
          )}
          {problem && (
            <div
              ref={refs.problem}
              tabIndex={-1}
              className="error-banner"
              role="alert"
            >
              <p>{problem}</p>
            </div>
          )}
          {hasData === false && (
            <p className="muted">Nothing to back up yet.</p>
          )}
          {hasData === true && (
            <div className="import-actions">
              <button
                ref={refs.download}
                className="primary"
                disabled={busy}
                onClick={startBackup}
              >
                {busy ? 'Making backup…' : 'Download backup'}
              </button>
              {remembered && (
                <button ref={refs.change} disabled={busy} onClick={startChange}>
                  Change passphrase
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default BackupSection;
