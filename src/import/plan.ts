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
import type { CardRecord, StatementRecord } from '../db/schema';
import { statementFingerprint } from '../lib/txnId';

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
): CardRef {
  const { last4 } = parsed;
  // The same file imported again belongs to the card it went to last time —
  // the only way to recognise a statement whose card number is unreadable.
  if (parsed.transactions.length > 0) {
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
    return { kind: 'new', last4: null, suggestedNickname: 'New card' };
  }

  const existing = existingCards.find((card) => card.last4 === last4);
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
    suggestedNickname: `Card ····${last4.replace(/X/g, '')}`,
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

function planOneFile(
  parsed: ParsedStatement,
  existingCards: CardRecord[],
  existingStatements: StatementRecord[],
  newCardsByLast4: Map<string, CardRef>,
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

  if (existingStatement !== undefined) {
    const newTxnCount = parsed.transactions.length;
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
      supersedes: newTxnCount > existingStatement.txnCount,
      refreshes:
        existingStatement.fingerprint ===
        statementFingerprint(parsed.transactions),
      previous: existingStatement,
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

  return { kind: 'new-statement', parsed, period, cardRef, needsDueDay };
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
        newCardsByLast4,
      ),
    );
  }

  return keepFullestInBatch(outcomes);
}

/** Two files in one batch for the same card and month: only the one with
 * the most transactions is written (keep-fullest, ties to the first); the
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

  outcomes.forEach((o, i) => {
    const key = groupKey(o);
    if (key === null) return;
    const best = winners.get(key);
    if (best === undefined || count(o) > count(outcomes[best])) {
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
