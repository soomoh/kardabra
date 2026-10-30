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
      /** Undated exports (stored, other months) that also hold some of
       * these transactions: those rows are removed from them once this
       * statement is written, so nothing is counted twice and the export's
       * other months stay. */
      trims?: StatementRecord[];
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
      /** An undated export (a bank's CSV of transactions, which follows no
       * billing cycle) that overlaps this statement — stored, or another
       * file in the batch. Not written, so nothing is counted twice. */
      overlaps?: { period: string; fileName: string };
      /** As on 'new-statement', for a superseding file. */
      trims?: StatementRecord[];
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
function periodOf(parsed: ParsedStatement): string | null {
  const statementDateISO = parsed.summary.statementDateISO;
  if (statementDateISO !== undefined) return statementDateISO.slice(0, 7);
  const maxTxnDateISO = maxTransactionDateISO(parsed.transactions);
  return maxTxnDateISO === null ? null : maxTxnDateISO.slice(0, 7);
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

/** The fields of a stored transaction the overlap check reads. */
export type StoredTransaction = Pick<
  TransactionRecord,
  'cardId' | 'statementId' | 'dateISO' | 'amount'
>;

/** Date and amount only: banks word the same transaction differently in a
 * CSV export and the PDF statement, but never change when or how much. */
const overlapKey = (t: { dateISO: string; amount: number }) =>
  `${t.dateISO}|${t.amount}`;

/** Rows two lists share, as a multiset: three identical metro rides on one
 * day match at most as many rides as the other side has. */
function sharedRows(
  a: readonly { dateISO: string; amount: number }[],
  b: readonly { dateISO: string; amount: number }[],
): number {
  const counts = new Map<string, number>();
  for (const t of a)
    counts.set(overlapKey(t), (counts.get(overlapKey(t)) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const left = counts.get(overlapKey(t)) ?? 0;
    if (left === 0) continue;
    shared++;
    counts.set(overlapKey(t), left - 1);
  }
  return shared;
}

/** Whether `shared` rows out of the smaller side's `total` is the same
 * money seen twice: at least two, and at least half. One coincidence (the
 * same amount on the same day) never counts, nor a couple in a big file. */
function isOverlap(shared: number, total: number): boolean {
  return shared >= 2 && shared * 2 >= total;
}

/** A real statement carries its statement date; a bank's CSV export of
 * transactions doesn't, and follows no billing cycle. Overlaps only ever
 * involve an export: two statements' cycles never overlap. */
const isDated = (p: ParsedStatement) =>
  p.summary.statementDateISO !== undefined;

/** Stored statements of this card in other months that share transactions
 * with the file, most shared first. */
function storedOverlaps(
  parsed: ParsedStatement,
  period: string,
  cardId: string,
  existingStatements: StatementRecord[],
  existingTransactions: readonly StoredTransaction[],
): StatementRecord[] {
  const rowsByStatement = new Map<string, StoredTransaction[]>();
  for (const t of existingTransactions) {
    if (t.cardId !== cardId) continue;
    const rows = rowsByStatement.get(t.statementId) ?? [];
    rows.push(t);
    rowsByStatement.set(t.statementId, rows);
  }
  const found: { statement: StatementRecord; shared: number }[] = [];
  for (const statement of existingStatements) {
    const rows = rowsByStatement.get(statement.id);
    if (rows === undefined || statement.period === period) continue;
    const shared = sharedRows(rows, parsed.transactions);
    const smaller = Math.min(rows.length, parsed.transactions.length);
    if (isOverlap(shared, smaller)) found.push({ statement, shared });
  }
  return found.sort((a, b) => b.shared - a.shared).map((f) => f.statement);
}

function planOneFile(
  parsed: ParsedStatement,
  existingCards: CardRecord[],
  existingStatements: StatementRecord[],
  existingTransactions: readonly StoredTransaction[],
  newCardsByLast4: Map<string, CardRef>,
  assignment: string | undefined,
): FileOutcome {
  const period = periodOf(parsed);
  if (period === null) {
    return {
      kind: 'failed',
      fileName: parsed.fileName,
      message:
        'could not determine the statement period: no statement date was recovered and the file has no transactions to infer one from',
    };
  }

  const cardRef = resolveCardRef(
    parsed,
    period,
    existingCards,
    existingStatements,
    newCardsByLast4,
    assignment,
  );

  // A brand-new card can't already have a statement for this period —
  // duplicate detection only makes sense against a card that already
  // exists in the database.
  const existingStatement =
    cardRef.kind === 'existing'
      ? existingStatements.find(
          (s) => s.cardId === cardRef.cardId && s.period === period,
        )
      : undefined;

  const overlapping =
    cardRef.kind === 'existing'
      ? storedOverlaps(
          parsed,
          period,
          cardRef.cardId,
          existingStatements,
          existingTransactions,
        )
      : [];
  // A statement takes its rows back from the exports it overlaps,
  // whichever came first.
  const trims = isDated(parsed)
    ? overlapping.filter((s) => s.statementDateISO === undefined)
    : [];

  if (existingStatement !== undefined) {
    const newTxnCount = parsed.transactions.length;
    const sameFile =
      existingStatement.fingerprint ===
      statementFingerprint(parsed.transactions);
    const storedIsStatement = existingStatement.statementDateISO !== undefined;
    // An export never replaces a statement: "more rows" may be rows from
    // another cycle. A statement always replaces an export.
    const exportOverStatement = !isDated(parsed) && storedIsStatement;
    const statementOverExport = isDated(parsed) && !storedIsStatement;
    // An export overlapping a statement in another month never replaces
    // anything: re-dropping an export that statement already trimmed
    // would bring the trimmed rows back.
    const overlapsElsewhere = !isDated(parsed) ? overlapping[0] : undefined;
    const supersedes =
      statementOverExport ||
      (newTxnCount > existingStatement.txnCount &&
        !exportOverStatement &&
        overlapsElsewhere === undefined);
    // Same month, so one of the two must go: the export's rows this
    // statement doesn't hold go with it, and the review says how many.
    const storedRows = existingTransactions.filter(
      (t) => t.statementId === existingStatement.id,
    );
    const exportRowsDropped = statementOverExport
      ? storedRows.length - sharedRows(storedRows, parsed.transactions)
      : 0;
    return {
      kind: 'duplicate',
      fileName: parsed.fileName,
      parsed,
      period,
      cardRef,
      existingTxnCount: existingStatement.txnCount,
      newTxnCount,
      // Keep-fullest: a re-import only replaces the stored statement when
      // it recovered strictly more transactions than what's already there.
      supersedes,
      refreshes: sameFile,
      previous: existingStatement,
      ...(overlapsElsewhere !== undefined && !sameFile
        ? {
            overlaps: {
              period: overlapsElsewhere.period,
              fileName: overlapsElsewhere.fileName,
            },
          }
        : exportOverStatement && !sameFile
          ? {
              overlaps: {
                period: existingStatement.period,
                fileName: existingStatement.fileName,
              },
            }
          : {}),
      // Only a file that is written trims anything.
      ...(supersedes && trims.length > 0 ? { trims } : {}),
      ...(exportRowsDropped > 0 ? { exportRowsDropped } : {}),
    };
  }

  const overlap = isDated(parsed) ? undefined : overlapping[0];
  if (overlap !== undefined) {
    return {
      kind: 'duplicate',
      fileName: parsed.fileName,
      parsed,
      period,
      cardRef,
      existingTxnCount: overlap.txnCount,
      newTxnCount: parsed.transactions.length,
      supersedes: false,
      refreshes: false,
      overlaps: { period: overlap.period, fileName: overlap.fileName },
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
  };
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
  /** Stored transactions, for the overlap check (see storedOverlap). */
  existingTransactions: readonly StoredTransaction[] = [],
): FileOutcome[] {
  const newCardsByLast4 = new Map<string, CardRef>();
  const outcomes: FileOutcome[] = [];

  for (const result of parseResults) {
    if ('error' in result) {
      outcomes.push(outcomeForError(result.fileName, result.error));
      continue;
    }
    outcomes.push(
      planOneFile(
        result.parsed,
        existingCards,
        existingStatements,
        existingTransactions,
        newCardsByLast4,
        assignments.get(result.fileName),
      ),
    );
  }

  return overlapInBatch(keepFullestInBatch(outcomes));
}

/** Two files in one batch, filed under different months but holding the
 * same transactions: a CSV export beside the PDF statement, or two exports.
 * Only one is written — the statement over an export, else the fuller,
 * else the first. A file with no card number may be any card, so it is
 * compared with every other (a first import has no card to ask about). */
function overlapInBatch(outcomes: FileOutcome[]): FileOutcome[] {
  type Writing = Extract<FileOutcome, { kind: 'new-statement' | 'duplicate' }>;
  const writes = (o: FileOutcome): o is Writing =>
    o.kind === 'new-statement' || (o.kind === 'duplicate' && o.supersedes);
  const sameCard = (a: Writing, b: Writing) => {
    const unnumbered = (o: Writing) =>
      o.cardRef.kind === 'new' && o.cardRef.last4 === null;
    return (
      unnumbered(a) ||
      unnumbered(b) ||
      cardInputKey(a.cardRef, a.parsed.fileName) ===
        cardInputKey(b.cardRef, b.parsed.fileName)
    );
  };
  const result = [...outcomes];
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      const [a, b] = [result[i], result[j]];
      if (!writes(a) || !writes(b) || a.period === b.period) continue;
      if (isDated(a.parsed) && isDated(b.parsed)) continue;
      if (!sameCard(a, b)) continue;
      const shared = sharedRows(a.parsed.transactions, b.parsed.transactions);
      const smaller = Math.min(
        a.parsed.transactions.length,
        b.parsed.transactions.length,
      );
      if (!isOverlap(shared, smaller)) continue;
      const bWins =
        isDated(a.parsed) !== isDated(b.parsed)
          ? isDated(b.parsed)
          : b.parsed.transactions.length > a.parsed.transactions.length;
      const [winner, loserIndex] = bWins ? [b, i] : [a, j];
      const loser = result[loserIndex] as Writing;
      result[loserIndex] = {
        kind: 'duplicate',
        fileName: loser.parsed.fileName,
        parsed: loser.parsed,
        period: loser.period,
        cardRef: loser.cardRef,
        existingTxnCount: winner.parsed.transactions.length,
        newTxnCount: loser.parsed.transactions.length,
        supersedes: false,
        refreshes: false,
        inBatch: true,
        overlaps: { period: winner.period, fileName: winner.parsed.fileName },
      };
    }
  }
  return result;
}

/** Two files in one batch for the same card and month: only the one with
 * the most transactions is written (keep-fullest, ties to the first; a
 * statement always beats an export, which may hold another cycle's rows); the
 * rest become non-writing duplicates. Without this both would be written and
 * the later one would win regardless of which was more complete. */
function keepFullestInBatch(outcomes: FileOutcome[]): FileOutcome[] {
  const winners = new Map<string, number>(); // group key -> outcome index
  const groupKey = (o: FileOutcome): string | null => {
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
  // A statement beats an export for the same month, however many rows.
  const dated = (o: FileOutcome): boolean =>
    (o.kind === 'new-statement' || o.kind === 'duplicate') && isDated(o.parsed);
  const fuller = (o: FileOutcome, than: FileOutcome): boolean =>
    dated(o) !== dated(than) ? dated(o) : count(o) > count(than);

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
