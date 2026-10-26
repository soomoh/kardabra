import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { parseDob } from '../lib/pdfPassword';
import {
  BANK_NAMES,
  bankFromFileName,
  statementsSummary,
} from '../lib/bankDetect';
import type { UnlockInput } from '../import/read';

interface PasswordStepProps {
  fileNames: string[];
  /** A previous attempt left these files locked. */
  retry: boolean;
  unlocking: boolean;
  onUnlock: (input: UnlockInput) => void;
  onSkip: () => void;
}

/**
 * Asked once per import for every locked PDF in the batch. First just name
 * and date of birth, which open most banks' statements; the card's last four
 * digits (SBI) are asked only for files still locked after that. Passwords
 * the user already knows can be listed at any point — each is tried on every
 * file, so nobody has to match passwords to files.
 *
 * What's typed lives only in this component's state: kept across the retry
 * so nothing is typed twice, gone when the step closes, never stored or sent
 * anywhere.
 */
function PasswordStep({
  fileNames,
  retry,
  unlocking,
  onUnlock,
  onSkip,
}: PasswordStepProps) {
  const [name, setName] = useState('');
  const [dobText, setDobText] = useState('');
  const [last4Text, setLast4Text] = useState('');
  const [passwords, setPasswords] = useState<string[]>(['']);
  const [wantsPasswords, setWantsPasswords] = useState(false);
  const last4Ref = useRef<HTMLInputElement>(null);

  // A retry reveals the last-4 field: move focus to it so the new question
  // is noticed (and announced), not just appended below the fold.
  useEffect(() => {
    if (retry) last4Ref.current?.focus();
  }, [retry]);

  const dob = parseDob(dobText);
  const hasDetails = name.trim() !== '' && dob !== null;
  const typed = passwords.filter((p) => p !== '');
  const canSubmit = !unlocking && (hasDetails || typed.length > 0);
  const showPasswords = retry || wantsPasswords;

  function setPassword(index: number, value: string) {
    setPasswords(passwords.map((p, i) => (i === index ? value : p)));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    onUnlock({
      details: hasDetails
        ? {
            name,
            dob,
            last4s: last4Text.split(/[\s,]+/).filter((s) => /^\d{4}$/.test(s)),
          }
        : undefined,
      passwords: typed,
    });
  }

  const count = fileNames.length;
  return (
    <section>
      <p className="lede">
        Banks lock statements with a password, usually made from your name and
        date of birth. Enter them once and we'll unlock{' '}
        {count === 1 ? 'it' : `all ${count}`} for you. Nothing you type is
        saved, and it never leaves this device.
      </p>
      <form className="password-form" onSubmit={submit}>
        <label>
          Name as on your card
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          Date of birth
          {dobText.trim() !== '' && dob === null && (
            <span className="error-text"> — use DD/MM/YYYY</span>
          )}
          <input
            type="text"
            inputMode="numeric"
            value={dobText}
            onChange={(e) => setDobText(e.target.value)}
            aria-invalid={dobText.trim() !== '' && dob === null}
            placeholder="DD/MM/YYYY"
            autoComplete="off"
          />
        </label>
        {retry && (
          <div className="callout">
            <p role="alert">
              {count === 1 ? 'One file is' : `${count} files are`} still locked.
              Some banks, like SBI, also use your card's last 4 digits. Add
              them, or enter the password if you know it.
            </p>
            <label>
              Card's last 4 digits
              <input
                ref={last4Ref}
                type="text"
                inputMode="numeric"
                value={last4Text}
                onChange={(e) => setLast4Text(e.target.value)}
                placeholder="4242"
                aria-describedby="last4-hint"
                autoComplete="off"
              />
              <span id="last4-hint" className="field-hint">
                More than one card? Add them all, separated by spaces.
              </span>
            </label>
          </div>
        )}
        {showPasswords ? (
          <fieldset className="password-list">
            <legend>Passwords you know</legend>
            <p className="muted">
              Add as many as you like — we'll try each one on every file.
            </p>
            {passwords.map((password, i) => (
              <input
                key={i}
                type="password"
                value={password}
                onChange={(e) => setPassword(i, e.target.value)}
                aria-label={`Password ${i + 1}`}
                autoComplete="off"
              />
            ))}
            <button
              type="button"
              className="link-button"
              onClick={() => setPasswords([...passwords, ''])}
            >
              + Add another password
            </button>
          </fieldset>
        ) : (
          <button
            type="button"
            className="link-button"
            onClick={() => setWantsPasswords(true)}
          >
            Have the passwords? Enter them instead
          </button>
        )}
        <div className="import-actions">
          <button type="submit" className="primary" disabled={!canSubmit}>
            {unlocking ? 'Unlocking…' : 'Unlock'}
          </button>
          <button type="button" onClick={onSkip} disabled={unlocking}>
            Skip {count === 1 ? 'this file' : 'these files'}
          </button>
        </div>
      </form>
      <details className="file-summary">
        <summary>
          {retry ? 'Still locked: ' : ''}
          {statementsSummary(fileNames)}
        </summary>
        <ul className="plain-list">
          {fileNames.map((fileName) => {
            const bank = bankFromFileName(fileName);
            return (
              <li key={fileName}>
                {fileName}
                {bank && <span className="muted"> · {BANK_NAMES[bank]}</span>}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}

export default PasswordStep;
