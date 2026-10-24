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
  StatementSummary,
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
import { isValidDueDay, nextDueDateWithGraceISO } from '../lib/dates';
import { netSpend, identifyPaymentIndices } from '../lib/spend';
import { cardIdKey, statementFingerprint, transactionIds } from '../lib/txnId';

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
  // Ask for the due day whenever the card doesn't already have a stored one —
  // for every new card, and for an existing card that was never given one.
  // Parsed statement due dates aren't relied on for this yet, so the import
  // experience is consistent: the user always sets the due day for a new card.
  const needsDueDay =
    cardRef.kind === 'new' || existingCard?.dueDay === undefined;

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

/** Drop keys whose value is undefined, so optional record fields are
 * genuinely absent rather than present-and-undefined. */
function defined<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, v]) => v !== undefined),
  ) as T;
}

/** The new file's summary, with any field it lacks taken from the statement
 * it replaces — a supersede adds transactions, it never loses a total. */
function mergedSummary(
  summary: StatementSummary,
  previous: StatementRecord | undefined,
): StatementSummary {
  if (previous === undefined) return summary;
  return defined({
    statementDateISO: summary.statementDateISO ?? previous.statementDateISO,
    paymentDueDateISO: summary.paymentDueDateISO ?? previous.dueDateISO,
    totalDue: summary.totalDue ?? previous.totalDue,
    minDue: summary.minDue ?? previous.minDue,
    creditLimit: summary.creditLimit ?? previous.creditLimit,
    creditBalance: summary.creditBalance ?? previous.creditBalance,
    openingBalance: summary.openingBalance ?? previous.openingBalance,
    paymentsTotal: summary.paymentsTotal ?? previous.paymentsTotal,
    purchasesTotal: summary.purchasesTotal ?? previous.purchasesTotal,
    chargesTotal: summary.chargesTotal ?? previous.chargesTotal,
  });
}

function toStatementRecord(
  id: string,
  cardId: string,
  period: string,
  parsed: ParsedStatement,
  summary: StatementSummary,
): StatementRecord {
  return defined({
    id,
    cardId,
    period,
    statementDateISO: summary.statementDateISO,
    dueDateISO: summary.paymentDueDateISO,
    totalDue: summary.totalDue,
    minDue: summary.minDue,
    creditLimit: summary.creditLimit,
    creditBalance: summary.creditBalance,
    openingBalance: summary.openingBalance,
    paymentsTotal: summary.paymentsTotal,
    purchasesTotal: summary.purchasesTotal,
    chargesTotal: summary.chargesTotal,
    currency: parsed.currency,
    skippedRows: parsed.warnings.length,
    fingerprint: statementFingerprint(parsed.transactions),
    fileName: parsed.fileName,
    txnCount: parsed.transactions.length,
    importedAt: new Date().toISOString(),
  });
}

function toTransactionRecords(
  statementId: string,
  card: { id: string; last4: string | null },
  parsed: ParsedStatement,
): TransactionRecord[] {
  const ids = transactionIds(cardIdKey(card), parsed.transactions);
  return parsed.transactions.map((txn, i) => ({
    id: ids[i],
    statementId,
    cardId: card.id,
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
  const createdCards = new Map<string, CardRecord>();

  // Every card touched by this commit (new statement or refreshed
  // duplicate) needs its spends recomputed once, after every write in the
  // batch has landed — see the call after the loop below. A Set, not a
  // running recompute-per-outcome: recomputing after each individual write
  // would use a different card's still-mid-batch statements as "the
  // history", and would just be wasted work when several outcomes in one
  // batch touch the same card (e.g. three months' history for one card).
  const affectedCardIds = new Set<string>();

  function dueDayFor(key: string): number | undefined {
    const day = userInput.dueDays.get(key);
    if (day !== undefined && !isValidDueDay(day)) {
      // The import UI validates before enabling Import; getting here means
      // it didn't — a programmer mistake, so it throws.
      throw new Error(`commitImport: invalid due day ${day} (key "${key}")`);
    }
    return day;
  }

  async function resolveCard(
    cardRef: CardRef,
    fileName: string,
    currency: string,
  ): Promise<CardRecord> {
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
      // An existing card that never had a due day: the plan asked for one
      // (needsDueDay), so keep the answer — otherwise it is asked again on
      // every import and never used.
      const answered = dueDayFor(record.id);
      if (record.dueDay === undefined && answered !== undefined) {
        const updated = { ...record, dueDay: answered };
        await putCard(db, updated);
        return updated;
      }
      return record;
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

    const card: CardRecord = defined({
      id: crypto.randomUUID(),
      last4: cardRef.last4,
      nickname,
      dueDay: dueDayFor(key),
      currency,
      createdAt: new Date().toISOString(),
    });
    await putCard(db, card);
    result.cardsCreated++;
    createdCards.set(key, card);
    return card;
  }

  for (const outcome of outcomes) {
    if (outcome.kind === 'rejected' || outcome.kind === 'failed') continue;

    if (outcome.kind === 'duplicate' && !outcome.supersedes) {
      result.duplicatesSkipped++;
      // Refresh path: the *same* file re-dropped re-derives its cycle (due
      // date, totals) so improved derivation logic heals old data, without
      // rewriting transactions or losing paidAt (upsertCycle keeps it). A
      // different, thinner file must not overwrite the stored month.
      if (!outcome.refreshes) continue;
      const card = await resolveCard(
        outcome.cardRef,
        outcome.fileName,
        outcome.parsed.currency,
      );
      const summary = mergedSummary(outcome.parsed.summary, outcome.previous);
      await upsertCycle(
        db,
        buildCycleRecord(card, outcome.period, outcome.parsed, summary),
      );
      affectedCardIds.add(card.id);
      continue;
    }
    if (outcome.kind === 'duplicate') {
      result.duplicatesSuperseded++;
      // falls through: a superseding duplicate is written exactly like a
      // new statement — putStatementWithTransactions already knows how to
      // replace whatever's there.
    }

    const { parsed, period, cardRef } = outcome;
    const card = await resolveCard(cardRef, parsed.fileName, parsed.currency);
    const summary = mergedSummary(
      parsed.summary,
      outcome.kind === 'duplicate' ? outcome.previous : undefined,
    );

    const statementId = crypto.randomUUID();
    const statement = toStatementRecord(
      statementId,
      card.id,
      period,
      parsed,
      summary,
    );
    const txnRecords = toTransactionRecords(statementId, card, parsed);
    await putStatementWithTransactions(db, statement, txnRecords);
    result.statementsWritten++;

    await upsertCycle(db, buildCycleRecord(card, period, parsed, summary));
    affectedCardIds.add(card.id);
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
  card: CardRecord,
  period: string,
  parsed: ParsedStatement,
  summary: StatementSummary,
): CycleRecord {
  const cardId = card.id;
  const { dueDay } = card;
  // The user-set `dueDay` wins: project the due date from it relative to this
  // statement's dateline (with a minimum grace gap — see nextDueDateWithGraceISO
  // for the mis-projection it prevents). Only when no due day is known does the
  // statement's own parsed due date stand in; with neither, the due date stays
  // the null sentinel (unknown) rather than failing the commit.
  const anchorDateISO =
    summary.statementDateISO ?? maxTransactionDateISO(parsed.transactions);
  const dueDateISO =
    dueDay !== undefined && anchorDateISO !== null
      ? nextDueDateWithGraceISO(anchorDateISO, dueDay)
      : (summary.paymentDueDateISO ?? null);

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

  return defined({
    cardId,
    period,
    dueDateISO,
    source: 'statement' as const,
    spend,
    totalDue: summary.totalDue,
    minDue: summary.minDue,
  });
}
