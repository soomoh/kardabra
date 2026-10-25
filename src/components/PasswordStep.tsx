import { useState } from 'react';
import type { FormEvent } from 'react';
import { parseDob } from '../lib/pdfPassword';
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
 * Asked once per import for every locked PDF in the batch. What's typed
 * lives only in this component's state: it is gone when the step closes and
 * is never stored or sent anywhere.
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
  const [password, setPassword] = useState('');

  const dob = parseDob(dobText);
  const hasDetails = name.trim() !== '' && dob !== null;
  const canSubmit = !unlocking && (hasDetails || password !== '');

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
      password: password === '' ? undefined : password,
    });
  }

  const count = fileNames.length;
  return (
    <section>
      <h2>Password-protected statements</h2>
      <p>
        {count === 1 ? 'This statement is' : `These ${count} statements are`}{' '}
        locked with the bank's statement password. Enter your details once and
        Kardabra tries each bank's usual password pattern. Nothing you type is
        saved or leaves this device.
      </p>
      <ul className="plan-list">
        {fileNames.map((fileName) => (
          <li key={fileName} className="plan-row">
            <div className="plan-row-file">{fileName}</div>
          </li>
        ))}
      </ul>
      {retry && (
        <p className="error-text" role="alert">
          {count === 1 ? "That didn't" : `Those details didn't`} open{' '}
          {count === 1 ? 'it' : 'these'}. Check them, or type the password
          itself.
        </p>
      )}
      <form className="password-form" onSubmit={submit}>
        <label>
          Name as on the card
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          Date of birth (DD/MM/YYYY)
          {dobText.trim() !== '' && dob === null && (
            <span className="error-text"> Use DD/MM/YYYY</span>
          )}
          <input
            type="text"
            inputMode="numeric"
            value={dobText}
            onChange={(e) => setDobText(e.target.value)}
            placeholder="DD/MM/YYYY"
            autoComplete="off"
          />
        </label>
        <label>
          Cards' last 4 digits (optional — some banks use them)
          <input
            type="text"
            inputMode="numeric"
            value={last4Text}
            onChange={(e) => setLast4Text(e.target.value)}
            placeholder="e.g. 4242, 1234"
            autoComplete="off"
          />
        </label>
        <label>
          Or the statement password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="import-actions">
          <button type="button" onClick={onSkip} disabled={unlocking}>
            Skip {count === 1 ? 'this file' : 'these files'}
          </button>
          <button type="submit" disabled={!canSubmit}>
            {unlocking ? 'Unlocking…' : 'Unlock'}
          </button>
        </div>
      </form>
    </section>
  );
}

export default PasswordStep;
