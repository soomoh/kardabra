/**
 * Planning an import: decide, per file, what WOULD happen — new statement,
 * duplicate, rejected, failed — without writing anything. Pure, so it is
 * tested with plain inputs and no database; commit.ts does the writing.
 * The UI asks only what the plan says is needed (a due day the statement
 * doesn't print), never more.
 *
 * Error containment: one ParseResult in, one FileOutcome out. A
 * StatementError is an expected rejection (wrong statement type,
 * unreadable layout) and any other error is a per-file 'failed' outcome —
 * neither aborts the batch.
 */

import type {
  ParsedStatement,
  StatementErrorKind,
  Transaction,
} from '../parser';
import { StatementError } from '../parser';
import type {
  CardRecord,
  StatementRecord,
  TransactionRecord,
} from '../db/schema';
import { statementFingerprint } from '../lib/txnId';
import {
  cyclePeriod,
  isExport,
  sharedCount,
  splitByCycle,
  statementDayOf,
  withoutKnown,
} from './exports';
import { confirmedIssuer } from '../lib/bankDetect';

/** One file's parse outcome, as the caller (which actually calls
 * `parseStatementBytes` inside a try/catch) hands it to `planImport`.
 * `fileName` is hoisted out to this wrapper rather than left inside
 * `ParsedStatement` because the error branch has no `ParsedStatement` at
 * all — parsing itself is what failed. */
export type ParseResult =
  | { fileName: string; parsed: ParsedStatement }
  | { fileName: string; error: unknown };

/** Which card a statement belongs to — either a card already in the
 * database, or one that doesn't exist yet and needs a nickname from the
 * user before `commitImport` can create it. */
export type CardRef =
  | { kind: 'existing'; cardId: string; nickname: string }
  | { kind: 'new'; last4: string | null; suggestedNickname: string };

export type FileOutcome =
  | {
      kind: 'new-statement';
      parsed: ParsedStatement;
      period: string;
      cardRef: CardRef;
      needsDueDay: boolean;
      /** Stored files without a statement date (exports, mostly) that also
       * hold some of these transactions in another month: those rows are
       * removed from them once this statement is written, so nothing is
       * counted twice. Their other rows stay. */
      trims?: StatementRecord[];
      /** A piece of an export: how many of its rows were left out because
       * they are already stored. */
      alreadyImported?: number;
    }
  | {
      // A superseding duplicate still has to be *written* by commitImport,
      // which needs the actual parsed data to write — `parsed` is carried
      // here for that reason, not just for display.
      kind: 'duplicate';
      fileName: string;
      parsed: ParsedStatement;
      period: string;
      cardRef: CardRef;
      existingTxnCount: number;
      newTxnCount: number;
      supersedes: boolean;
      /** The same file as the stored one (identical transactions): its cycle
       * is re-derived so improved derivation logic heals old data. A
       * different, thinner file never touches the stored month. */
      refreshes: boolean;
      /** The stored statement this one would replace — its summary fields
       * fill any the new file lacks, so a supersede never loses a total. */
      previous?: StatementRecord;
      /** Lost to a fuller file for the same card and month in this batch. */
      inBatch?: boolean;
      /** As on 'new-statement', for a superseding file. */
      trims?: StatementRecord[];
      /** A piece of an export whose rows are all already stored. */
      alreadyImported?: number;
      /** A piece of an export adding this many new rows to the month's
       * stored export (written as the two merged). */
      adds?: number;
      /** A piece of an export with rows the month's stored statement
       * doesn't hold. A statement is never replaced by an export, so they
       * aren't added; the review says how many. */
      notAdded?: number;
      /** Another file in this batch holds all of this piece's rows. */
      alreadyIn?: string;
      /** A statement superseding an export filed under the same month: how
       * many of the export's rows it doesn't hold, which go with it. */
      exportRowsDropped?: number;
    }
  | {
      kind: 'rejected';
      fileName: string;
      errorKind: StatementErrorKind;
      advice: string;
    }
  | { kind: 'failed'; fileName: string; message: string }; // unexpected error — per-file, never aborts the batch

/**
 * Stable key identifying "which card a piece of user input is about".
 *
 * For an existing card this is just its `cardId`. A *new* card has no id
 * yet at plan time (commitImport only mints one when it actually creates
 * the row) — so nicknames/dueDays have to be collected against something
 * else. `last4` is that something else when it's known (and is exactly
 * the value `planImport`'s batch dedupe already keys new cards by, so two
 * files needing the same new card share one key and the UI asks once).
 * When `last4` is null there's nothing to dedupe against (see
 * `planImport`'s header comment on why null-last4 cards are never
 * merged), so the introducing file's own name stands in as a key that's
 * at least guaranteed unique within one batch.
 */
/** A card assignment's value meaning "this file is a card not yet in
 * Kardabra" (any other value is an existing card's id). */
export const NEW_CARD = 'new';

export function cardInputKey(cardRef: CardRef, fileName: string): string {
  if (cardRef.kind === 'existing') return cardRef.cardId;
  return cardRef.last4 ?? `new:${fileName}`;
}

/** ISO date of the latest transaction, or null if there are none — the
 * fallback period marker when a statement has no statement date at all. */
export function maxTransactionDateISO(
  transactions: Transaction[],
): string | null {
  if (transactions.length === 0) return null;
  let max = transactions[0].dateISO;
  for (const txn of transactions) {
    if (txn.dateISO > max) max = txn.dateISO;
  }
  return max;
}

/**
 * The billing period ('YYYY-MM') a parsed statement belongs to.
 *
 * The statement's own `statementDateISO`, when present, wins over
 * inferring a period from transaction dates. A statement's dateline
 * is the truer period marker — e.g. a statement dated 2025-10-31 covering
 * transactions from late September through late October unambiguously
 * belongs to the October cycle by the bank's own accounting, regardless of
 * which month most of its transactions happen to fall in. Transactions are
 * only the fallback for statements with no recovered statement date at
 * all (ICICI's summary sometimes lacks one — see summary.test.ts).
 *
 * Returns null when neither is available (no statement date and no
 * transactions) — there is no period to assign, so the caller has to
 * treat this as a failed file rather than guess.
 */
function periodOf(
  parsed: ParsedStatement,
  /** The card's statement day, when known: an undated file's last row then
   * names its cycle, not just its calendar month (exports.ts). */
  statementDay: number | null,
): string | null {
  const statementDateISO = parsed.summary.statementDateISO;
  if (statementDateISO !== undefined) return statementDateISO.slice(0, 7);
  const maxTxnDateISO = maxTransactionDateISO(parsed.transactions);
  return maxTxnDateISO === null
    ? null
    : cyclePeriod(maxTxnDateISO, statementDay);
}

/**
 * Match a parsed statement's card to an existing card by last4, or plan a
 * new one. `newCardsByLast4` is the batch-level dedupe: two files in the
 * same `planImport` call that share a non-null last4 not yet in the
 * database must resolve to the *same* 'new' CardRef object, so the plan
 * only asks the user for one nickname even though several statements need
 * that card to exist. A null last4 is never deduped this way — nothing
 * distinguishes one statement with an unrecoverable card number from
 * another, so each becomes its own 'new' CardRef.
 */
function resolveCardRef(
  parsed: ParsedStatement,
  period: string,
  existingCards: CardRecord[],
  existingStatements: StatementRecord[],
  newCardsByLast4: Map<string, CardRef>,
  /** The user's answer to "Which card is this?", when given: an existing
   * card's id or NEW_CARD. It overrides every automatic match. */
  assignment?: string,
): CardRef {
  const { last4 } = parsed;
  const issuer = confirmedIssuer(parsed);
  const assigned =
    assignment === undefined || assignment === NEW_CARD
      ? undefined
      : existingCards.find((card) => card.id === assignment);
  if (assigned !== undefined) {
    return {
      kind: 'existing',
      cardId: assigned.id,
      nickname: assigned.nickname,
    };
  }
  const automatic = assignment !== NEW_CARD;
  // The same file imported again belongs to the card it went to last time —
  // the only way to recognise a statement whose card number is unreadable.
  if (automatic && parsed.transactions.length > 0) {
    const fingerprint = statementFingerprint(parsed.transactions);
    const same = existingStatements.find(
      (s) => s.period === period && s.fingerprint === fingerprint,
    );
    const card = same && existingCards.find((c) => c.id === same.cardId);
    if (card !== undefined) {
      return { kind: 'existing', cardId: card.id, nickname: card.nickname };
    }
  }

  if (last4 === null) {
    // No number to name it by: the issuer, when the statement itself names
    // one. Never a placeholder like "New card", which reads as unfinished
    // on the dashboard, and never a file-name guess (review shows that as
    // "likely …" beside the name instead).
    return {
      kind: 'new',
      last4: null,
      suggestedNickname: issuer ? `${issuer} card` : 'Unnamed card',
    };
  }

  const existing = automatic
    ? existingCards.find((card) => card.last4 === last4)
    : undefined;
  if (existing !== undefined) {
    return {
      kind: 'existing',
      cardId: existing.id,
      nickname: existing.nickname,
    };
  }

  const alreadyPlanned = newCardsByLast4.get(last4);
  if (alreadyPlanned !== undefined) return alreadyPlanned;

  const fresh: CardRef = {
    kind: 'new',
    last4,
    suggestedNickname: `${issuer ?? 'Card'} ····${last4.replace(/X/g, '')}`,
  };
  newCardsByLast4.set(last4, fresh);
  return fresh;
}

function outcomeForError(fileName: string, error: unknown): FileOutcome {
  if (error instanceof StatementError) {
    return {
      kind: 'rejected',
      fileName,
      errorKind: error.kind,
      advice: error.advice,
    };
  }
  // Not a StatementError: an unrecognised failure mode (a real bug, most
  // likely), but still contained to this one file — see this module's
  // header comment on error containment.
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'failed', fileName, message };
}

/** The fields of a stored transaction planning reads: matching rows across
 * files, and merging an export's new rows into a stored month. */
export type StoredTransaction = Pick<
  TransactionRecord,
  'cardId' | 'statementId' | 'dateISO' | 'amount' | 'payee'
>;

/** A stored export: none of a statement's summary was recorded (exports.ts
 * isExport). A real statement missing only its date is not one, and is
 * never merged into or trimmed. */
const storedIsExport = (s: StatementRecord) =>
  s.statementDateISO === undefined &&
  s.dueDateISO === undefined &&
  s.totalDue === undefined;

/** Stored exports of this card, in other months, that share rows with a
 * statement being imported. */
function storedToTrim(
  parsed: ParsedStatement,
  period: string,
  cardId: string,
  existingStatements: StatementRecord[],
  existingTransactions: readonly StoredTransaction[],
): StatementRecord[] {
  return existingStatements.filter(
    (s) =>
      s.cardId === cardId &&
      s.period !== period &&
      storedIsExport(s) &&
      sharedCount(
        existingTransactions.filter((t) => t.statementId === s.id),
        parsed.transactions,
      ) > 0,
  );
}

function planOneFile(
  original: ParsedStatement,
  period: string,
  existingCards: CardRecord[],
  existingStatements: StatementRecord[],
  existingTransactions: readonly StoredTransaction[],
  newCardsByLast4: Map<string, CardRef>,
  assignment: string | undefined,
): FileOutcome {
  const cardRef = resolveCardRef(
    original,
    period,
    existingCards,
    existingStatements,
    newCardsByLast4,
    assignment,
  );
  const cardRows =
    cardRef.kind === 'existing'
      ? existingTransactions.filter((t) => t.cardId === cardRef.cardId)
      : [];
  // A brand-new card can't already have a statement for this period —
  // duplicate detection only makes sense against a card that already
  // exists in the database.
  const existingStatement =
    cardRef.kind === 'existing'
      ? existingStatements.find(
          (s) => s.cardId === cardRef.cardId && s.period === period,
        )
      : undefined;
  const base = {
    fileName: original.fileName,
    period,
    cardRef,
    previous: existingStatement,
  };

  // An export's rows already stored for this card are left out, so
  // re-dropping it, or an overlapping one, never counts anything twice.
  const exportPiece = isExport(original);
  const { kept, removed } = exportPiece
    ? withoutKnown(original.transactions, cardRows)
    : { kept: original.transactions, removed: 0 };
  const parsed = { ...original, transactions: kept };
  if (exportPiece && kept.length === 0) {
    return {
      kind: 'duplicate',
      ...base,
      parsed: original, // shown, never written
      existingTxnCount: existingStatement?.txnCount ?? removed,
      newTxnCount: 0,
      supersedes: false,
      refreshes: false,
      alreadyImported: removed,
    };
  }

  const dated = parsed.summary.statementDateISO !== undefined;
  const trims =
    dated && cardRef.kind === 'existing'
      ? storedToTrim(
          parsed,
          period,
          cardRef.cardId,
          existingStatements,
          existingTransactions,
        )
      : [];

  if (existingStatement !== undefined) {
    const storedRows = cardRows.filter(
      (t) => t.statementId === existingStatement.id,
    );
    const storedDated = existingStatement.statementDateISO !== undefined;
    const duplicate = {
      kind: 'duplicate' as const,
      ...base,
      existingTxnCount: existingStatement.txnCount,
      newTxnCount: parsed.transactions.length,
    };
    if (exportPiece) {
      const leftOut = removed > 0 ? { alreadyImported: removed } : {};
      // New rows for a month already here: added to a stored export (the
      // two written as one); never to a statement, which an export can't
      // replace.
      if (!storedIsExport(existingStatement)) {
        return {
          ...duplicate,
          parsed: original, // shown, never written
          supersedes: false,
          refreshes: false,
          notAdded: kept.length,
          ...leftOut,
        };
      }
      const merged = [
        ...storedRows.map(({ dateISO, payee, amount }) => ({
          dateISO,
          payee,
          amount,
        })),
        ...kept,
      ];
      return {
        ...duplicate,
        parsed: { ...parsed, transactions: merged },
        newTxnCount: merged.length,
        supersedes: true,
        refreshes: false,
        adds: kept.length,
        ...leftOut,
      };
    }
    // A statement always replaces a file without a statement date; one
    // without a date never replaces a statement ("more rows" may be
    // another cycle's). Otherwise keep-fullest: strictly more rows wins.
    const statementOverUndated = dated && !storedDated;
    const supersedes =
      statementOverUndated ||
      (parsed.transactions.length > existingStatement.txnCount &&
        (dated || !storedDated));
    const exportRowsDropped = statementOverUndated
      ? storedRows.length - sharedCount(storedRows, parsed.transactions)
      : 0;
    return {
      ...duplicate,
      parsed,
      supersedes,
      refreshes:
        existingStatement.fingerprint ===
        statementFingerprint(parsed.transactions),
      // Only a file that is written trims anything.
      ...(supersedes && trims.length > 0 ? { trims } : {}),
      ...(exportRowsDropped > 0 ? { exportRowsDropped } : {}),
    };
  }

  const existingCard =
    cardRef.kind === 'existing'
      ? existingCards.find((card) => card.id === cardRef.cardId)
      : undefined;
  // The statement's own due date is used when it prints one; the due day is
  // asked only as the fallback — no printed date and none stored for the card.
  const needsDueDay =
    parsed.summary.paymentDueDateISO === undefined &&
    (cardRef.kind === 'new' || existingCard?.dueDay === undefined);

  return {
    kind: 'new-statement',
    parsed,
    period,
    cardRef,
    needsDueDay,
    ...(trims.length > 0 ? { trims } : {}),
    ...(removed > 0 ? { alreadyImported: removed } : {}),
  };
}

/** The statement day to cut an export by: its card's, from stored
 * statements (the card the user picked, or the one its number matches),
 * else from a statement for the same number in this batch. */
function statementDayFor(
  parsed: ParsedStatement,
  assignment: string | undefined,
  existingCards: CardRecord[],
  existingStatements: StatementRecord[],
  batch: readonly ParsedStatement[],
): number | null {
  const card =
    existingCards.find((c) => c.id === assignment) ??
    (parsed.last4 === null || assignment === NEW_CARD
      ? undefined
      : existingCards.find((c) => c.last4 === parsed.last4));
  const stored =
    card === undefined
      ? []
      : existingStatements
          .filter((s) => s.cardId === card.id)
          .map((s) => s.statementDateISO);
  const inBatch =
    parsed.last4 === null
      ? []
      : batch
          .filter((b) => b.last4 === parsed.last4)
          .map((b) => b.summary.statementDateISO);
  return statementDayOf(stored) ?? statementDayOf(inBatch);
}

/**
 * Plan a batch import: decide, per file, what would happen without
 * writing anything. Pure function — same inputs always produce the same
 * outcomes, which is what makes it testable without a database at all.
 */
export function planImport(
  parseResults: ParseResult[],
  existingCards: CardRecord[],
  existingStatements: StatementRecord[],
  /** File name → the user's "Which card is this?" answer (card id or
   * NEW_CARD); see review.ts cardQuestion. */
  assignments: ReadonlyMap<string, string> = new Map(),
  /** Stored transactions: an export's rows already here are left out, and
   * a statement takes its rows back from stored exports. */
  existingTransactions: readonly StoredTransaction[] = [],
): FileOutcome[] {
  const newCardsByLast4 = new Map<string, CardRef>();
  const outcomes: FileOutcome[] = [];
  const batch = parseResults.flatMap((r) => ('parsed' in r ? [r.parsed] : []));

  for (const result of parseResults) {
    if ('error' in result) {
      outcomes.push(outcomeForError(result.fileName, result.error));
      continue;
    }
    const { parsed, fileName } = result;
    const assignment = assignments.get(fileName);
    const day = statementDayFor(
      parsed,
      assignment,
      existingCards,
      existingStatements,
      batch,
    );
    // An export becomes one piece per billing cycle, each planned like a
    // statement file of its own (same file name, so the review keeps them
    // together and Remove takes the whole file).
    // (An empty file has no rows to cut, and fails below like any other.)
    const pieces =
      isExport(parsed) && parsed.transactions.length > 0
        ? splitByCycle(parsed, day)
        : [{ parsed, period: periodOf(parsed, day) }];
    for (const piece of pieces) {
      if (piece.period === null) {
        outcomes.push({
          kind: 'failed',
          fileName,
          message:
            'could not determine the statement period: no statement date was recovered and the file has no transactions to infer one from',
        });
        continue;
      }
      outcomes.push(
        planOneFile(
          piece.parsed,
          piece.period,
          existingCards,
          existingStatements,
          existingTransactions,
          newCardsByLast4,
          assignment,
        ),
      );
    }
  }

  // Statements settle their months first; export pieces then give up rows
  // the surviving statements hold, and merge with each other.
  return exportsInBatch(keepFullestInBatch(outcomes));
}

/** Whether an outcome writes an export piece: a new month, or new rows
 * merged into a stored export's month. */
type ExportWrite = Extract<
  FileOutcome,
  { kind: 'new-statement' | 'duplicate' }
>;
const writesExport = (o: FileOutcome): o is ExportWrite =>
  (o.kind === 'new-statement' || (o.kind === 'duplicate' && o.supersedes)) &&
  isExport(o.parsed);

/** Export pieces against the rest of the batch, after keep-fullest has
 * settled the statements: rows a statement being written already holds are
 * left out; a month a statement in the batch covers isn't added; and two
 * exports' pieces for the same card and month become one. A file with no
 * card number joins a statement's card only on two or more shared rows
 * across the whole file: one shared row can be two cards paying the same
 * subscription on the same day. */
function exportsInBatch(outcomes: FileOutcome[]): FileOutcome[] {
  const key = (o: ExportWrite) => cardInputKey(o.cardRef, o.parsed.fileName);
  const statements = outcomes.filter(
    (o): o is ExportWrite =>
      (o.kind === 'new-statement' ||
        (o.kind === 'duplicate' && o.supersedes)) &&
      !isExport(o.parsed),
  );
  const fileRows = new Map<string, Transaction[]>();
  for (const o of outcomes) {
    if (!writesExport(o)) continue;
    const rows = fileRows.get(o.parsed.fileName) ?? [];
    fileRows.set(o.parsed.fileName, [...rows, ...o.parsed.transactions]);
  }
  // An unnumbered export sharing two or more rows with a statement is
  // that statement's card: all its months go there, not to a new
  // "Unnamed card" (a first import has no card to ask about).
  const adopted = new Map<string, CardRef>();
  for (const [fileName, rows] of fileRows) {
    const piece = outcomes.find(
      (o): o is ExportWrite =>
        writesExport(o) && o.parsed.fileName === fileName,
    );
    if (piece?.cardRef.kind !== 'new' || piece.cardRef.last4 !== null) continue;
    const match = statements.find(
      (s) => sharedCount(rows, s.parsed.transactions) >= 2,
    );
    if (match !== undefined) adopted.set(fileName, match.cardRef);
  }
  const sameCard = (o: ExportWrite, s: ExportWrite) =>
    cardInputKey(s.cardRef, s.parsed.fileName) === key(o);
  const skipped = (
    o: ExportWrite,
    extra: { alreadyIn?: string; notAdded?: number },
  ): FileOutcome => ({
    kind: 'duplicate',
    fileName: o.parsed.fileName,
    parsed: o.parsed, // shown, never written
    period: o.period,
    cardRef: o.cardRef,
    existingTxnCount: o.parsed.transactions.length,
    newTxnCount: 0,
    supersedes: false,
    refreshes: false,
    inBatch: true,
    ...(extra.alreadyIn !== undefined ? { alreadyIn: extra.alreadyIn } : {}),
    ...(extra.notAdded ? { notAdded: extra.notAdded } : {}),
  });

  const result: FileOutcome[] = [];
  const pieceAt = new Map<string, number>(); // card|period -> index in result
  for (const original of outcomes) {
    if (!writesExport(original)) {
      result.push(original);
      continue;
    }
    const card = adopted.get(original.parsed.fileName);
    const o: ExportWrite =
      card === undefined ? original : { ...original, cardRef: card };
    // A merge's rows include the stored month's; only its new ones compete.
    const stored =
      o.kind === 'duplicate' ? o.parsed.transactions.length - (o.adds ?? 0) : 0;
    let rows = o.parsed.transactions.slice(stored);
    let holder: string | undefined;
    let monthTaken = false;
    for (const s of statements) {
      if (!sameCard(o, s)) continue;
      const { kept, removed } = withoutKnown(rows, s.parsed.transactions);
      if (removed > 0) holder = s.parsed.fileName;
      rows = kept;
      if (s.period === o.period) {
        monthTaken = true;
        holder = s.parsed.fileName;
      }
    }
    if (monthTaken) {
      result.push(skipped(o, { alreadyIn: holder, notAdded: rows.length }));
      continue;
    }
    const groupKey = `${key(o)}|${o.period}`;
    const earlier = pieceAt.get(groupKey);
    if (earlier !== undefined) {
      // Another export's piece for this month: its new rows join, each once.
      const first = result[earlier] as ExportWrite;
      const { kept } = withoutKnown(rows, first.parsed.transactions);
      result[earlier] = {
        ...first,
        parsed: {
          ...first.parsed,
          transactions: [...first.parsed.transactions, ...kept],
        },
        ...(first.kind === 'duplicate'
          ? {
              adds: (first.adds ?? 0) + kept.length,
              newTxnCount: first.newTxnCount + kept.length,
            }
          : {}),
      } as ExportWrite;
      result.push(skipped(o, { alreadyIn: first.parsed.fileName }));
      continue;
    }
    if (rows.length === 0) {
      result.push(skipped(o, { alreadyIn: holder }));
      continue;
    }
    pieceAt.set(groupKey, result.length);
    result.push(
      o.kind === 'duplicate'
        ? {
            ...o,
            parsed: {
              ...o.parsed,
              transactions: [
                ...o.parsed.transactions.slice(0, stored),
                ...rows,
              ],
            },
            adds: rows.length,
            newTxnCount: stored + rows.length,
          }
        : { ...o, parsed: { ...o.parsed, transactions: rows } },
    );
  }
  return result;
}

/** Two statement files in one batch for the same card and month: only the
 * one with the most transactions is written (keep-fullest, ties to the
 * first; a dated statement beats an undated one); the
 * rest become non-writing duplicates. Without this both would be written and
 * the later one would win regardless of which was more complete. */
function keepFullestInBatch(outcomes: FileOutcome[]): FileOutcome[] {
  const winners = new Map<string, number>(); // group key -> outcome index
  const groupKey = (o: FileOutcome): string | null => {
    // Export pieces merge rather than compete (exportsInBatch). (A plain
    // boolean: the type guard would narrow `o` away below.)
    const exportPiece: boolean = writesExport(o);
    if (exportPiece) return null;
    if (o.kind === 'new-statement') {
      return `${cardInputKey(o.cardRef, o.parsed.fileName)}|${o.period}`;
    }
    // A refresh re-derives the stored month, so it competes too: alongside
    // a fuller superseding file it must lose, or it would re-apply the old
    // file's totals after the new one was written.
    if (o.kind === 'duplicate' && (o.supersedes || o.refreshes)) {
      return `${cardInputKey(o.cardRef, o.fileName)}|${o.period}`;
    }
    return null;
  };
  const count = (o: FileOutcome): number =>
    o.kind === 'new-statement' || o.kind === 'duplicate'
      ? o.parsed.transactions.length
      : 0;
  // For the same month a dated statement beats one without a date,
  // however many rows.
  const rank = (o: FileOutcome): number =>
    (o.kind === 'new-statement' || o.kind === 'duplicate') &&
    o.parsed.summary.statementDateISO !== undefined
      ? 1
      : 0;
  const fuller = (o: FileOutcome, than: FileOutcome): boolean =>
    rank(o) !== rank(than) ? rank(o) > rank(than) : count(o) > count(than);

  outcomes.forEach((o, i) => {
    const key = groupKey(o);
    if (key === null) return;
    const best = winners.get(key);
    if (best === undefined || fuller(o, outcomes[best])) {
      winners.set(key, i);
    }
  });

  return outcomes.map((o, i) => {
    const key = groupKey(o);
    if (key === null || winners.get(key) === i) return o;
    if (o.kind !== 'new-statement' && o.kind !== 'duplicate') return o;
    const kept = outcomes[winners.get(key)!];
    return {
      kind: 'duplicate',
      fileName: o.parsed.fileName,
      parsed: o.parsed,
      period: o.period,
      cardRef: o.cardRef,
      existingTxnCount: count(kept),
      newTxnCount: count(o),
      supersedes: false,
      refreshes: false,
      inBatch: true,
    };
  });
}
