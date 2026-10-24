/**
 * PDF → anonymized positioned text. A rewritten PDF would have to re-embed
 * fonts for the replaced glyphs; instead the output is the pdf.js text layer
 * itself (each item's string and position), which is exactly what the PDF
 * importer consumes. Running the same pdf.js version as the app means a
 * contributed file reproduces the app's extraction faithfully.
 *
 * Items on one visual line are anonymized together so a date or amount split
 * across items ("06" "Nov" "'25") is still recognised as one token.
 */

import type { Anonymizer } from './anonymizer';

export interface PdfTextItem {
  s: string; // text
  x: number;
  y: number;
  w: number;
  h: number;
  eol: boolean;
}
export interface PdfText {
  format: 'kardabra-pdf-text/1';
  pdfjs: string;
  pages: { width: number; height: number; items: PdfTextItem[] }[];
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

export function looksLikePdf(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/** Thrown when a PDF needs a password, or the given one is wrong. */
export class PdfPasswordError extends Error {
  constructor(readonly reason: 'needed' | 'incorrect') {
    super(
      reason === 'needed'
        ? 'this PDF is password-protected — enter the statement password'
        : 'that password did not open the PDF — check it and try again',
    );
  }
}

/** Anonymize the strings of one line's items, keeping item boundaries. A token
 * that spans items lands whole in the item where it starts. */
export function anonymizeLine(strings: string[], anon: Anonymizer): string[] {
  const joined = strings.join(' ');
  const out = anon.text(joined);
  if (out === joined) return strings;
  // Replacements keep length for everything except scaled amounts, so map by
  // walking both strings token-by-token on the shared separators.
  const outParts = out.split(' ');
  const inParts = joined.split(' ');
  if (outParts.length !== inParts.length) {
    // A replacement introduced or removed a space — rare; keep line order by
    // putting the whole line in the first item.
    return [out, ...strings.slice(1).map(() => '')];
  }
  const result: string[] = [];
  let k = 0;
  for (const s of strings) {
    const n = s.split(' ').length;
    result.push(outParts.slice(k, k + n).join(' '));
    k += n;
  }
  return result;
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/**
 * Open a PDF: first with no password, then with each candidate in order.
 * `unlockedWith` is the index of the password that worked (null when none
 * was needed) — never the password itself. Throws PdfPasswordError when
 * nothing opens it.
 */
async function openPdf(pdfjs: PdfJs, bytes: Uint8Array, passwords: string[]) {
  const attempts: (string | undefined)[] = [undefined, ...passwords];
  for (const [i, password] of attempts.entries()) {
    const task = pdfjs.getDocument({
      data: bytes.slice(), // pdf.js detaches the buffer it's given
      password,
      useSystemFonts: false,
      verbosity: 0,
    });
    try {
      const doc = await task.promise;
      return { task, doc, unlockedWith: i === 0 ? null : i - 1 };
    } catch (error) {
      await task.destroy();
      if (!(error instanceof Error && error.name === 'PasswordException')) {
        throw error;
      }
    }
  }
  throw new PdfPasswordError(passwords.length > 0 ? 'incorrect' : 'needed');
}

export async function anonymizePdf(
  bytes: Uint8Array,
  anon: Anonymizer,
  passwords: string[] = [],
): Promise<{ text: PdfText; unlockedWith: number | null }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { task, doc, unlockedWith } = await openPdf(pdfjs, bytes, passwords);

  const pages: PdfText['pages'] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const raw of content.items) {
      if (!('str' in raw)) continue;
      items.push({
        s: raw.str,
        x: round(raw.transform[4]),
        y: round(raw.transform[5]),
        w: round(raw.width),
        h: round(raw.height),
        eol: raw.hasEOL,
      });
    }
    // Group by visual line (same baseline), anonymize each line together.
    const lines = new Map<number, PdfTextItem[]>();
    for (const item of items) {
      const key = Math.round(item.y);
      lines.set(key, [...(lines.get(key) ?? []), item]);
    }
    for (const line of lines.values()) {
      line.sort((a, b) => a.x - b.x);
      const replaced = anonymizeLine(
        line.map((i) => i.s),
        anon,
      );
      line.forEach((item, i) => (item.s = replaced[i]));
    }
    pages.push({
      width: round(viewport.width),
      height: round(viewport.height),
      items,
    });
  }
  await task.destroy();
  return {
    text: { format: 'kardabra-pdf-text/1', pdfjs: pdfjs.version, pages },
    unlockedWith,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
