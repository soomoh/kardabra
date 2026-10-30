/**
 * Step zero of an import: turn a batch of dropped files into ParseResults
 * for `planImport`. Spreadsheets parse synchronously; PDFs go through
 * pdf.js, and a password-protected PDF is set aside as `locked` so the UI
 * can ask for the cardholder's details ONCE for the whole batch, then
 * `unlockFiles` tries each bank's password patterns per file.
 *
 * The details typed are used and dropped. What comes back per opened file
 * is the pattern id ('name4U+ddmm', not personal, tried first next month)
 * and the password itself, which the caller seals (savedPasswords.ts) when
 * the user asked to remember it, or drops.
 *
 * The PDF opener is injected (`PdfReader`) so this runs in Node tests with
 * pdf.js's legacy build and in the browser with the bundled worker.
 */

import {
  looksLikePdf,
  parsePdfText,
  parseStatementBytes,
  PdfPasswordError,
  StatementError,
  type PdfPage,
} from '../parser';
import { bankFromFileName } from '../lib/bankDetect';
import {
  passwordCandidates,
  type Candidate,
  type PasswordInputs,
} from '../lib/pdfPassword';
import { fileDiagnostic } from './feedback';
import type { ParseResult } from './plan';

/** Statements are a few hundred kB, scanned PDFs a few MB. Anything far
 * beyond is not a statement, and reading it could freeze the tab. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** A file over the cap, as a plan row that says why — built from its size
 * alone, so the caller can refuse it before reading a byte. */
export function tooLargeResult(fileName: string): ParseResult {
  return {
    fileName,
    error: new StatementError(
      'too-large',
      `file is over ${MAX_FILE_BYTES / 1024 / 1024} MB`,
      'This is too big to be a card statement. Check you picked the right file.',
    ),
  };
}

export type PdfReader = (
  bytes: Uint8Array,
  passwords: string[],
) => Promise<{ pages: PdfPage[]; unlockedWith: number | null }>;

/** Called after each file is handled: how many are done, out of how many. */
export type Progress = (done: number, total: number) => void;

export interface InputFile {
  name: string;
  bytes: Uint8Array;
}

export interface ReadResult {
  results: ParseResult[];
  /** Password-protected PDFs still waiting for the user's details. */
  locked: InputFile[];
  /** Number-masked diagnostics for unreadable spreadsheets, by file name. */
  diagnostics: Map<string, string>;
}

/** Parse each file; one bad file becomes one error result, never an
 * exception that aborts the batch (see plan.ts on error containment). */
export async function readStatementFiles(
  files: InputFile[],
  readPdf: PdfReader,
  onProgress?: Progress,
): Promise<ReadResult> {
  const out: ReadResult = { results: [], locked: [], diagnostics: new Map() };
  for (const [index, file] of files.entries()) {
    if (index > 0) onProgress?.(index, files.length);
    if (file.bytes.length > MAX_FILE_BYTES) {
      out.results.push(tooLargeResult(file.name));
      continue;
    }
    if (looksLikePdf(file.bytes)) {
      try {
        const { pages } = await readPdf(file.bytes, []);
        out.results.push(parsePdf(file.name, pages));
      } catch (error) {
        if (error instanceof PdfPasswordError) out.locked.push(file);
        else out.results.push({ fileName: file.name, error });
      }
      continue;
    }
    try {
      const parsed = parseStatementBytes(file.name, file.bytes);
      out.results.push({ fileName: file.name, parsed });
    } catch (error) {
      out.results.push({ fileName: file.name, error });
      out.diagnostics.set(file.name, fileDiagnostic(file.bytes));
    }
  }
  onProgress?.(files.length, files.length);
  return out;
}

/** What the user typed in the password step: their details, any passwords
 * they know, or both. Each typed password is tried on every file, so the
 * user never has to say which password belongs to which file. */
export interface UnlockInput {
  details?: PasswordInputs;
  passwords?: string[];
}

/** The ordered passwords to try on one file: typed passwords first, then
 * the bank's patterns with the ones that opened this user's cards before
 * moved to the front. No password is tried twice. */
export function candidatesFor(
  fileName: string,
  input: UnlockInput,
  knownPatterns: string[],
): Candidate[] {
  const typed: Candidate[] = [
    ...new Set((input.passwords ?? []).filter((p) => p !== '')),
  ].map((password) => ({ pattern: 'typed', password }));
  if (input.details === undefined) return typed;
  const generated = passwordCandidates(
    input.details,
    bankFromFileName(fileName),
  );
  const known = generated.filter((c) => knownPatterns.includes(c.pattern));
  const rest = generated.filter((c) => !knownPatterns.includes(c.pattern));
  const tried = new Set(typed.map((c) => c.password));
  return [
    ...typed,
    ...[...known, ...rest].filter((c) => !tried.has(c.password)),
  ];
}

export interface UnlockResult {
  results: ParseResult[];
  stillLocked: InputFile[];
  /** File name → the pattern id that opened it (never a typed password). */
  patterns: Map<string, string>;
  /** File name → the password that opened it. Plaintext: seal or drop. */
  passwords: Map<string, string>;
}

export async function unlockFiles(
  locked: InputFile[],
  input: UnlockInput,
  knownPatterns: string[],
  readPdf: PdfReader,
  onProgress?: Progress,
): Promise<UnlockResult> {
  const out: UnlockResult = {
    results: [],
    stillLocked: [],
    patterns: new Map(),
    passwords: new Map(),
  };
  for (const [index, file] of locked.entries()) {
    if (index > 0) onProgress?.(index, locked.length);
    const candidates = candidatesFor(file.name, input, knownPatterns);
    if (candidates.length === 0) {
      out.stillLocked.push(file);
      continue;
    }
    try {
      const { pages, unlockedWith } = await readPdf(
        file.bytes,
        candidates.map((c) => c.password),
      );
      const opened =
        unlockedWith === null ? undefined : candidates[unlockedWith];
      if (opened !== undefined) {
        out.passwords.set(file.name, opened.password);
        if (opened.pattern !== 'typed') {
          out.patterns.set(file.name, opened.pattern);
        }
      }
      out.results.push(parsePdf(file.name, pages));
    } catch (error) {
      if (error instanceof PdfPasswordError) out.stillLocked.push(file);
      else out.results.push({ fileName: file.name, error });
    }
  }
  onProgress?.(locked.length, locked.length);
  return out;
}

/** Locked files the user chose to skip, as plan rows that say why. */
export function skippedLockedResults(locked: InputFile[]): ParseResult[] {
  return locked.map((file) => ({
    fileName: file.name,
    error: new StatementError(
      'pdf-locked',
      'password-protected PDF was not unlocked',
      'Skipped — this PDF is password-protected. Import it again any time with your details or its password.',
    ),
  }));
}

function parsePdf(fileName: string, pages: PdfPage[]): ParseResult {
  try {
    return { fileName, parsed: parsePdfText(fileName, pages) };
  } catch (error) {
    return { fileName, error };
  }
}
