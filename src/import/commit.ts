/**
 * Committing a plan (plan.ts) with the user's answers: create the cards it
 * needs, write each new or superseding statement with its transactions,
 * upsert each cycle, then recompute spend per affected card.
 *
 * A commit that arrives without an answer the plan asked for is a bug in
 * the caller, not a bad file, so it throws (see resolveCard).
 */

import type { IDBPDatabase } from 'idb';
import type { ParsedStatement, StatementSummary } from '../parser';
import type {
  KardabraSchema,
  CardRecord,
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../db/schema';
import type { Sealed } from '../lib/secretBox';
import {
  putCard,
  putPdfPassword,
  putStatementWithTransactions,
  upsertCycle,
  recomputeCardSpends,
} from '../db/db';
import { cycleDueDateISO, isValidDueDay } from '../lib/dates';
import { netSpend, identifyPaymentIndices } from '../lib/spend';
import { cardIdKey, statementFingerprint, transactionIds } from '../lib/txnId';
import {
  cardInputKey,
  maxTransactionDateISO,
  type CardRef,
  type FileOutcome,
} from './plan';

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
  /** File name → the password pattern that unlocked it (import/read.ts);
   * remembered on the file's card. */
  passwordPatterns?: Map<string, string>;
  /** File name → its password, encrypted (savedPasswords.ts). Present only
   * for files whose password the user asked to remember; stored on the
   * file's card, replacing any older one. */
  sealedPasswords?: Map<string, Sealed>;
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

  async function rememberPassword(fileName: string, cardId: string) {
    const sealed = userInput.sealedPasswords?.get(fileName);
    if (sealed !== undefined) await putPdfPassword(db, { cardId, ...sealed });
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
      const pattern = userInput.passwordPatterns?.get(fileName);
      const updated = { ...record };
      if (record.dueDay === undefined && answered !== undefined) {
        updated.dueDay = answered;
      }
      if (pattern !== undefined) updated.pdfPasswordPattern = pattern;
      if (
        updated.dueDay !== record.dueDay ||
        updated.pdfPasswordPattern !== record.pdfPasswordPattern
      ) {
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
      pdfPasswordPattern: userInput.passwordPatterns?.get(fileName),
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
      // Re-importing a month already stored still remembers its password.
      if (outcome.cardRef.kind === 'existing') {
        await rememberPassword(outcome.fileName, outcome.cardRef.cardId);
      }
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
    // After the statement: a password is kept only for a file that landed.
    await rememberPassword(parsed.fileName, card.id);

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
  // Projecting from the statement date, else the last transaction: see
  // cycleDueDateISO, and nextDueDateWithGraceISO for the grace gap.
  const anchorDateISO =
    summary.statementDateISO ?? maxTransactionDateISO(parsed.transactions);
  const dueDateISO = cycleDueDateISO(
    summary.paymentDueDateISO,
    anchorDateISO,
    dueDay,
  );

  // Spend = debits minus cashback/refund-style credits, with the
  // identified bill-payment SET excluded (see lib/spend.ts for the
  // classification ladder and its safety reasoning). Always computable
  // even when the bank's export carries no summary block at all — the
  // dashboard shows it as "Spent this cycle ₹X" when totalDue is absent, which is
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
