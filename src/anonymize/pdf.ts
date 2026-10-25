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
import { readPdfText, type PdfItem, type PdfPage } from '../parser/pdf';

export { looksLikePdf, PdfPasswordError } from '../parser/pdf';
export type PdfTextItem = PdfItem;
export interface PdfText {
  format: 'kardabra-pdf-text/1';
  pdfjs: string;
  pages: PdfPage[];
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

export async function anonymizePdf(
  bytes: Uint8Array,
  anon: Anonymizer,
  passwords: string[] = [],
): Promise<{ text: PdfText; unlockedWith: number | null }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { pages, unlockedWith } = await readPdfText(pdfjs, bytes, passwords);
  for (const page of pages) {
    // Group by visual line (same baseline), anonymize each line together.
    const lines = new Map<number, PdfItem[]>();
    for (const item of page.items) {
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
  }
  return {
    text: { format: 'kardabra-pdf-text/1', pdfjs: pdfjs.version, pages },
    unlockedWith,
  };
}
