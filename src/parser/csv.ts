/**
 * A small, quote-aware delimited-text reader, plus the delimiter
 * auto-detection that picks between it.
 *
 * `line.split(delimiter)` is *not* a CSV parser — it silently corrupts any
 * field containing the delimiter or an embedded newline. Both show up in
 * these statements (ICICI quotes a comma-bearing disclaimer sentence;
 * narrations sometimes wrap), so a real RFC 4180 reader is needed: a field
 * wrapped in "..." may contain the delimiter or a raw newline, and "" inside
 * a quoted field is an escaped literal quote. JS has no such reader built
 * in, so this ~50-line state machine implements it directly rather than
 * pulling in a dependency for something this small.
 */

/** Parse one delimited-text document, using a single fixed delimiter, into
 * rows of cells. Quoting rules (RFC 4180): a field wrapped in "..." may
 * contain the delimiter or a raw newline; "" inside a quoted field is a
 * literal " character; a field outside quotes ends at the delimiter or a
 * newline. */
function parseWithDelimiter(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    if (row.length === 0 && field === '') {
      // A genuinely blank line (nothing at all before the newline) yields
      // an empty row rather than a row with one empty field — so
      // extractTransactions's "no parseable content" check treats it the
      // same way regardless of which reader produced the rows.
      rows.push([]);
      return;
    }
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"'; // "" escape for a literal quote inside a quoted field
        i += 2;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      endRow();
      i += char === '\r' && text[i + 1] === '\n' ? 2 : 1; // swallow a \r\n pair as one break
      continue;
    }
    field += char;
    i += 1;
  }
  // A final field/row only if the text didn't already end on a newline —
  // otherwise this would append a spurious trailing blank row.
  if (field !== '' || row.length > 0) {
    endField();
    rows.push(row);
  }
  return rows;
}

// Candidate delimiters, in the order they're tried on ties (HDFC uses '~'
// throughout, everyone else uses ',').
const CANDIDATE_DELIMITERS = ['~', '|', ',', '\t', ';'];

/** Rows with more than 2 columns are "real" data rows — a header or a
 * transaction line, not noise. Scoring by row shape (not a single sniffed
 * character) is what makes this correct even though HDFC's own narrations
 * sometimes contain a stray comma: the wrong delimiter never produces as
 * many wide rows as the right one. */
function scoreByWideRowCount(rows: string[][]): number {
  return rows.filter((row) => row.length > 2).length;
}

/**
 * Parse text of unknown delimiter into rows: try each candidate delimiter
 * with the quote-aware reader above, and keep whichever produced the most
 * multi-column rows. Ties keep the earliest candidate in
 * CANDIDATE_DELIMITERS. Returns the winning delimiter too, so a writer (the
 * anonymizer) can reproduce the file's own format.
 */
export function detectDelimited(text: string): {
  delimiter: string;
  rows: string[][];
} {
  let best = { delimiter: CANDIDATE_DELIMITERS[0], rows: [] as string[][] };
  let bestScore = -1;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const rows = parseWithDelimiter(text, delimiter);
    const score = scoreByWideRowCount(rows);
    if (score > bestScore) {
      best = { delimiter, rows };
      bestScore = score;
    }
  }
  return best;
}

/** Rows of a delimited document whose delimiter is unknown. */
export function parseDelimited(text: string): string[][] {
  return detectDelimited(text).rows;
}
