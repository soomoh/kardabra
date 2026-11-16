import { useEffect, useRef, useState } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { getStoredData } from '../db/db';
import { buildExportCsv } from '../export/csv';
import { formatDateLabel, todayISO } from '../lib/dates';
import { plural } from '../lib/plural';

type Result =
  | { kind: 'made'; fileName: string; rows: number }
  | { kind: 'none'; since: string }
  | { kind: 'unfinished' };

/** Download every transaction as a CSV for a spreadsheet or an accounting
 * app, optionally only those from a chosen date on. The layout is the
 * public export contract (src/export/csv.ts, README). */
function ExportSection({ hasData }: { hasData: boolean | null }) {
  const db = useDb();
  const reportError = useReportError();
  const [since, setSince] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  // Focus the result once it has rendered (see CLAUDE.md: setTimeout races).
  const focusResult = useRef(false);

  useEffect(() => {
    if (!focusResult.current || resultRef.current === null) return;
    resultRef.current.focus();
    focusResult.current = false;
  });

  function show(next: Result) {
    focusResult.current = true;
    setResult(next);
  }

  async function download() {
    if (busy) return;
    // A half-typed date reads as empty: exporting everything then would
    // hand over more than the user chose.
    if (dateRef.current?.validity.badInput) {
      show({ kind: 'unfinished' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const data = await getStoredData(db);
      const { csv, rows } = buildExportCsv(data, {
        since: since === '' ? undefined : since,
      });
      if (rows === 0) {
        show({ kind: 'none', since });
        return;
      }
      // Not dated: hledger remembers what it imported per file name, so the
      // same name each time is what stops a re-export importing twice.
      const fileName = 'kardabra-transactions.csv';
      const url = URL.createObjectURL(
        new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      // Long enough for the browser to take even a large file.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      show({ kind: 'made', fileName, rows });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Export transactions</h2>
      <p>
        Download your card transactions as a CSV file, for a spreadsheet or an
        accounting app such as hledger. The file isn’t encrypted, so keep it
        somewhere private.
      </p>

      {result?.kind === 'made' && (
        <div
          ref={resultRef}
          tabIndex={-1}
          className="notice inline-notice"
          role="status"
        >
          <p>
            Your export is {result.fileName}, with{' '}
            {plural(result.rows, 'transaction')}.
          </p>
        </div>
      )}
      {result?.kind === 'none' && (
        <div
          ref={resultRef}
          tabIndex={-1}
          className="notice inline-notice"
          role="status"
        >
          <p>
            No transactions from {formatDateLabel(result.since)} on. Choose an
            earlier date, or clear it to export everything.
          </p>
        </div>
      )}

      {result?.kind === 'unfinished' && (
        <div
          ref={resultRef}
          tabIndex={-1}
          className="error-banner"
          role="alert"
        >
          <p id="export-since-error">
            The start date isn’t complete. Finish the date or clear it.
          </p>
        </div>
      )}

      {hasData === false && <p className="muted">Nothing to export yet.</p>}
      {hasData === true && (
        <>
          <label className="field export-since">
            From (optional)
            <input
              ref={dateRef}
              type="date"
              value={since}
              aria-invalid={result?.kind === 'unfinished' || undefined}
              max={todayISO()}
              aria-describedby={
                result?.kind === 'unfinished'
                  ? 'export-since-error export-since-hint'
                  : 'export-since-hint'
              }
              onChange={(event) => {
                setSince(event.target.value);
                // A result about the old date would now mislead.
                setResult(null);
              }}
            />
          </label>
          <p id="export-since-hint" className="muted">
            Leave it empty to export every transaction.
          </p>
          <div className="import-actions">
            <button
              disabled={busy}
              onClick={() => void download().catch(reportError)}
            >
              {busy ? 'Making export…' : 'Download CSV'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export default ExportSection;
