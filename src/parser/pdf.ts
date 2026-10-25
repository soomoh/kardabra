/**
 * Open a PDF with pdf.js and read its text layer: each item's string and
 * position, which `parsePdfText` rebuilds into rows. Shared by the app
 * (browser build, bundled worker) and the anonymizer CLI (Node legacy
 * build) — the caller passes in its own pdf.js module, so the same code
 * extracts the same text in both and a contributed file reproduces the app.
 */

import type { PdfTextItem } from './pdfRows';

export type PdfJs = typeof import('pdfjs-dist');
type PdfWorker = InstanceType<PdfJs['PDFWorker']>;

/** One extracted text item; `eol` is pdf.js's end-of-line hint. */
export interface PdfItem extends PdfTextItem {
  eol: boolean;
}
export interface PdfPage {
  width: number;
  height: number;
  items: PdfItem[];
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

export function looksLikePdf(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/** Thrown when a PDF needs a password, or none of the given ones opened it. */
export class PdfPasswordError extends Error {
  constructor(readonly reason: 'needed' | 'incorrect') {
    super(
      reason === 'needed'
        ? 'this PDF is password-protected — enter the statement password'
        : 'that password did not open the PDF — check it and try again',
    );
    this.name = 'PdfPasswordError';
  }
}

/**
 * Open a PDF: first with no password, then with each candidate in order.
 * `unlockedWith` is the index of the password that worked (null when none
 * was needed) — never the password itself. Throws PdfPasswordError when
 * nothing opens it.
 */
async function openPdf(
  pdfjs: PdfJs,
  bytes: Uint8Array,
  passwords: string[],
  worker: PdfWorker | undefined,
) {
  const attempts: (string | undefined)[] = [undefined, ...passwords];
  for (const [i, password] of attempts.entries()) {
    const task = pdfjs.getDocument({
      data: bytes.slice(), // pdf.js detaches the buffer it's given
      password,
      worker,
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

/** Open a PDF (trying `passwords` if it is locked) and read every page's
 * positioned text. Pass a shared `worker` when opening many files or trying
 * many passwords, so each attempt doesn't start a new one. */
export async function readPdfText(
  pdfjs: PdfJs,
  bytes: Uint8Array,
  passwords: string[] = [],
  options: { worker?: PdfWorker } = {},
): Promise<{ pages: PdfPage[]; unlockedWith: number | null }> {
  const { task, doc, unlockedWith } = await openPdf(
    pdfjs,
    bytes,
    passwords,
    options.worker,
  );
  try {
    const pages: PdfPage[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfItem[] = [];
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
      pages.push({
        width: round(viewport.width),
        height: round(viewport.height),
        items,
      });
    }
    return { pages, unlockedWith };
  } finally {
    await task.destroy();
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
