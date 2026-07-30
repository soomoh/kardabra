/**
 * The import pipeline, split into two pure-ish steps:
 *
 *   1. `planImport` — pure function, no DB writes. Takes whatever came
 *      back from parsing a batch of files (a `ParsedStatement` per file
 *      that parsed, or the error it threw) plus a snapshot of what's
 *      already in the database, and decides what *would* happen to each
 *      file without doing it. The import UI renders this plan and asks
 *      the user only what the plan says is actually needed (a nickname
 *      for a new card, a due-day for a card whose statements never state
 *      one) — never more.
 *   2. `commitImport` — takes the plan plus the user's answers and
 *      actually writes to IndexedDB.
 *
 * Splitting these matters for testability (the seam): `planImport` is
 * tested as a plain function with plain inputs/outputs, no fake-indexeddb
 * needed at all — only `commitImport`'s tests need a real (fake) database.
 *
 * Error containment: this module's per-file boundary is exactly one
 * `ParseResult` in, one `FileOutcome` out. A `StatementError` is an
 * *expected* rejection (wrong statement type, unparseable file) — the
 * user's mistake (or just an irrelevant file), which degrades the batch
 * report by one line, never aborts it. Anything else unexpected also maps
 * to a per-file 'failed' outcome rather than being allowed to propagate
 * and abort the whole batch — but that's `planImport` being defensive
 * about *inputs it doesn't control* (whatever the caller's try/catch
 * around `parseStatementBytes` caught), not a license to swallow bugs
 * everywhere. A real programmer mistake inside `commitImport` itself
 * (e.g. the caller committing a plan without supplying an answer the plan
 * asked for) still throws — see `resolveCard` below.
 */

import type { IDBPDatabase } from 'idb';
import type {
  ParsedStatement,
  StatementErrorKind,
  Transaction,
} from '../parser';
import { StatementError } from '../parser';
import type {
  KardabraSchema,
  CardRecord,
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../db/schema';
import {
  putCard,
  putStatementWithTransactions,
  upsertCycle,
  recomputeCardSpends,
} from '../db/db';
import { nextDueDateWithGraceISO } from '../lib/dates';
import { netSpend, identifyPaymentIndices } from '../lib/spend';

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
function maxTransactionDateISO(transactions: Transaction[]): string | null {
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
  last4: string | null,
  existingCards: CardRecord[],
  newCardsByLast4: Map<string, CardRef>,
): CardRef {
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
    suggestedNickname: `Card ····${last4}`,
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

  const cardRef = resolveCardRef(parsed.last4, existingCards, newCardsByLast4);

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
    };
  }

  const existingCard =
    cardRef.kind === 'existing'
      ? existingCards.find((card) => card.id === cardRef.cardId)
      : undefined;
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

  return outcomes;
}

export interface CommitResult {
  cardsCreated: number;
  statementsWritten: number;
  duplicatesSkipped: number;
  duplicatesSuperseded: number;
}

/** What the user answered for each plan question, keyed by
 * `cardInputKey`. `dueDays` only needs entries for outcomes the plan
 * flagged `needsDueDay: true`; commitImport never consults it otherwise. */
export interface CommitUserInput {
  nicknames: Map<string, string>;
  dueDays: Map<string, number>;
}

function toStatementRecord(
  id: string,
  cardId: string,
  period: string,
  parsed: ParsedStatement,
): StatementRecord {
  const { summary } = parsed;
  return {
    id,
    cardId,
    period,
    ...(summary.statementDateISO !== undefined
      ? { statementDateISO: summary.statementDateISO }
      : {}),
    ...(summary.paymentDueDateISO !== undefined
      ? { dueDateISO: summary.paymentDueDateISO }
      : {}),
    ...(summary.totalDue !== undefined ? { totalDue: summary.totalDue } : {}),
    ...(summary.minDue !== undefined ? { minDue: summary.minDue } : {}),
    ...(summary.creditLimit !== undefined
      ? { creditLimit: summary.creditLimit }
      : {}),
    fileName: parsed.fileName,
    txnCount: parsed.transactions.length,
    importedAt: new Date().toISOString(),
  };
}

function toTransactionRecords(
  statementId: string,
  cardId: string,
  parsed: ParsedStatement,
): TransactionRecord[] {
  return parsed.transactions.map((txn) => ({
    statementId,
    cardId,
    dateISO: txn.dateISO,
    payee: txn.payee,
    amount: txn.amount,
  }));
}

/**
 * Commit a plan: create any cards it needs, write each new/superseding
 * statement and its transactions, and upsert each cycle's due-date and
 * amounts. Skips 'duplicate' outcomes that don't supersede, and 'rejected'
 * /'failed' outcomes entirely (there's nothing to write for either).
 */
export async function commitImport(
  db: IDBPDatabase<KardabraSchema>,
  outcomes: FileOutcome[],
  userInput: CommitUserInput,
): Promise<CommitResult> {
  const result: CommitResult = {
    cardsCreated: 0,
    statementsWritten: 0,
    duplicatesSkipped: 0,
    duplicatesSuperseded: 0,
  };

  // Two outcomes can share one 'new' CardRef object (planImport's batch
  // dedupe) — this remembers "already created in this commit" so the
  // second outcome reuses the id instead of creating a second card row.
  const createdCards = new Map<
    string,
    { cardId: string; dueDay: number | undefined }
  >();

  // Every card touched by this commit (new statement or refreshed
  // duplicate) needs its spends recomputed once, after every write in the
  // batch has landed — see the call after the loop below. A Set, not a
  // running recompute-per-outcome: recomputing after each individual write
  // would use a different card's still-mid-batch statements as "the
  // history", and would just be wasted work when several outcomes in one
  // batch touch the same card (e.g. three months' history for one card).
  const affectedCardIds = new Set<string>();

  async function resolveCard(
    cardRef: CardRef,
    fileName: string,
  ): Promise<{ cardId: string; dueDay: number | undefined }> {
    if (cardRef.kind === 'existing') {
      const record = await db.get('cards', cardRef.cardId);
      if (record === undefined) {
        // planImport built this cardId from the `existingCards` snapshot
        // the caller gave it — if it's not in the db now, the caller
        // committed against a stale or wrong snapshot. A programmer
        // mistake, not a user one: it throws rather than degrading.
        throw new Error(
          `commitImport: existing card ${cardRef.cardId} not found`,
        );
      }
      return { cardId: record.id, dueDay: record.dueDay };
    }

    const key = cardInputKey(cardRef, fileName);
    const already = createdCards.get(key);
    if (already !== undefined) return already;

    const nickname = userInput.nicknames.get(key);
    if (nickname === undefined) {
      // The plan said a new card here needs a nickname; a commit that
      // arrives without one means the caller (the import UI) didn't
      // resolve everything the plan asked for — again a programmer
      // mistake, not something a corrupt input file could trigger.
      throw new Error(
        `commitImport: no nickname supplied for new card (key "${key}")`,
      );
    }

    const dueDay = userInput.dueDays.get(key);
    const card: CardRecord = {
      id: crypto.randomUUID(),
      last4: cardRef.last4,
      nickname,
      ...(dueDay !== undefined ? { dueDay } : {}),
      createdAt: new Date().toISOString(),
    };
    await putCard(db, card);
    result.cardsCreated++;

    const created = { cardId: card.id, dueDay };
    createdCards.set(key, created);
    return created;
  }

  for (const outcome of outcomes) {
    if (outcome.kind === 'rejected' || outcome.kind === 'failed') continue;

    if (outcome.kind === 'duplicate' && !outcome.supersedes) {
      // The statement and its transactions stay as they are — but the
      // cycle's *derived* fields (due date, totals, spend) are recomputed
      // and upserted anyway. This is the refresh path: when the
      // derivation logic improves (e.g. the due-date grace gap), the user
      // re-drags the same files and stale cycles heal, without re-writing
      // transaction data or losing paidAt (upsertCycle preserves it).
      const { cardId, dueDay } = await resolveCard(
        outcome.cardRef,
        outcome.fileName,
      );
      await upsertCycle(
        db,
        buildCycleRecord(cardId, outcome.period, outcome.parsed, dueDay),
      );
      affectedCardIds.add(cardId);
      result.duplicatesSkipped++;
      continue;
    }
    if (outcome.kind === 'duplicate') {
      result.duplicatesSuperseded++;
      // falls through: a superseding duplicate is written exactly like a
      // new statement — putStatementWithTransactions already knows how to
      // replace whatever's there.
    }

    const { parsed, period, cardRef } = outcome;
    const { cardId, dueDay } = await resolveCard(cardRef, parsed.fileName);

    const statementId = crypto.randomUUID();
    const statement = toStatementRecord(statementId, cardId, period, parsed);
    const txnRecords = toTransactionRecords(statementId, cardId, parsed);
    await putStatementWithTransactions(db, statement, txnRecords);
    result.statementsWritten++;

    await upsertCycle(db, buildCycleRecord(cardId, period, parsed, dueDay));
    affectedCardIds.add(cardId);
  }

  // The authoritative spend pass: buildCycleRecord above only ever
  // computes a PROVISIONAL spend (no cross-statement priorExpectedDue
  // chain, no override — see its own comment), because at the point each
  // outcome is written mid-loop the rest of the batch (which might include
  // an earlier-period statement for the same card, changing what "prior"
  // means) hasn't landed yet. Once every write in the batch is committed,
  // recomputing per affected card — in period order, with each cycle's
  // saved override applied — is what makes cycle.spend correct regardless
  // of the order files were dropped in or duplicated across a batch.
  for (const cardId of affectedCardIds) {
    await recomputeCardSpends(db, cardId);
  }

  return result;
}

/** The cycle row a statement implies — all the derived facts in one
 * place, shared by the new-statement and duplicate-refresh paths so the
 * two can never compute them differently. */
function buildCycleRecord(
  cardId: string,
  period: string,
  parsed: ParsedStatement,
  dueDay: number | undefined,
): CycleRecord {
  // The statement's own due date wins when present — it's the bank's
  // authoritative answer. Otherwise, project one from the card's
  // ask-once `dueDay` relative to this statement's own dateline (with a
  // minimum grace gap — see nextDueDateWithGraceISO's comment for the
  // real mis-projection this prevents); with neither available the due
  // date stays the null sentinel (unknown), rather than the commit
  // failing outright.
  const anchorDateISO =
    parsed.summary.statementDateISO ??
    maxTransactionDateISO(parsed.transactions);
  const dueDateISO =
    parsed.summary.paymentDueDateISO ??
    (dueDay !== undefined && anchorDateISO !== null
      ? nextDueDateWithGraceISO(anchorDateISO, dueDay)
      : null);

  // Spend = debits minus cashback/refund-style credits, with the
  // identified bill-payment SET excluded (see lib/spend.ts for the
  // classification ladder and its safety reasoning). Always computable
  // even when the bank's export carries no summary block at all — the
  // dashboard shows it as "Spend ₹X" when totalDue is absent, which is
  // honest (spend is a fact) where inventing a bill amount would not be.
  //
  // This is only a PROVISIONAL figure: `priorExpectedDue: null` and
  // `override: undefined` here because this function has no visibility
  // into the rest of the batch being committed (an earlier-period
  // statement for the same card might land later in the same commit) or
  // into any override the user already saved on this cycle. commitImport's
  // recomputeCardSpends pass, run once per card after every write in the
  // batch has landed, is the authoritative one — see its call site.
  const spend = netSpend(
    parsed.transactions,
    identifyPaymentIndices(parsed.transactions, {
      priorExpectedDue: null,
      override: undefined,
    }),
  );

  return {
    cardId,
    period,
    dueDateISO,
    source: 'statement',
    spend,
    ...(parsed.summary.totalDue !== undefined
      ? { totalDue: parsed.summary.totalDue }
      : {}),
    ...(parsed.summary.minDue !== undefined
      ? { minDue: parsed.summary.minDue }
      : {}),
  };
}
