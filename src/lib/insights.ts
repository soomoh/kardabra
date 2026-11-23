/**
 * The Insights page's answers, as pure functions over stored records: where
 * the money went, what recurs, what the card costs, how much credit is used,
 * and charges that look doubled. Nothing is stored; everything is derived at
 * read time from the same labels the export uses (`transactionKind` over
 * `walkCardPayments`'s payment set), so a line counted as a fee here is a fee
 * in the export too.
 *
 * Periods are billing months (a statement's `period`), not calendar dates:
 * statements are the unit the user imports, and a range "last 3 months"
 * means their last three bills.
 */

import type {
  CardRecord,
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../db/schema';
import { addDaysISO, previousPeriod } from './dates';
import { transactionKind, type TransactionKind } from './kind';
import { classifyCharge } from './charges';
import { cleanMerchant, isBrand, merchantKey } from './merchant';
import { walkCardPayments } from './spend';

export interface InsightsInput {
  cards: CardRecord[];
  statements: StatementRecord[];
  transactions: TransactionRecord[];
  cycles: CycleRecord[];
}

/** One transaction with its derived labels. */
export interface LabelledTxn {
  id: string;
  cardId: string;
  period: string; // the statement's billing month
  dateISO: string;
  payee: string;
  merchant: string; // cleanMerchant(payee)
  /** lib/merchant.ts merchantKey: the grouping key, so "TATAPAYMENTS" and
   * "Tata Payments Limited" meet. `merchant` is the spelling shown for the
   * whole group (its most common one), so one merchant has one name. */
  merchantKey: string;
  amount: number; // out negative, in positive
  kind: TransactionKind;
}

/** Every transaction of every card, labelled. A card's statements are walked
 * oldest first, as the stored spend is, so `payment` matches it exactly. */
export function labelTransactions(input: InsightsInput): LabelledTxn[] {
  const txnsByStatement = new Map<string, TransactionRecord[]>();
  for (const txn of input.transactions) {
    const list = txnsByStatement.get(txn.statementId) ?? [];
    list.push(txn);
    txnsByStatement.set(txn.statementId, list);
  }
  const cycles = new Map(
    input.cycles.map((c) => [`${c.cardId}|${c.period}`, c]),
  );
  const out: LabelledTxn[] = [];
  for (const card of input.cards) {
    const statements = input.statements
      .filter((s) => s.cardId === card.id)
      .sort((a, b) => a.period.localeCompare(b.period));
    const walked = walkCardPayments(
      statements.map((statement) => {
        const cycle = cycles.get(`${card.id}|${statement.period}`);
        return {
          period: statement.period,
          totalDue: statement.totalDue,
          transactions: txnsByStatement.get(statement.id) ?? [],
          hasCycle: cycle !== undefined,
          override: cycle?.paymentOverride,
        };
      }),
    );
    statements.forEach((statement, s) => {
      const payments = new Set(walked[s].indices);
      (txnsByStatement.get(statement.id) ?? []).forEach((txn, t) => {
        const merchant = cleanMerchant(txn.payee);
        out.push({
          id: txn.id,
          cardId: card.id,
          period: statement.period,
          dateISO: txn.dateISO,
          payee: txn.payee,
          merchant,
          merchantKey: merchantKey(merchant),
          amount: txn.amount,
          kind: transactionKind(txn.payee, txn.amount, payments.has(t)),
        });
      });
    });
  }
  return withGroupNames(out);
}

/** A key this long or longer can stand for the keys it starts; a shorter
 * one ("TATA") is too likely a shared first word. */
const MIN_STEM = 8;

/**
 * Each merchant key mapped to its group's key: the shortest key in the data,
 * MIN_STEM characters or more, that it starts with. Banks print the name in
 * a fixed-width field, so variation lands at the end ("ORBGEN TECHNOLOGIES
 * PR", "TATA PAYMENTS LIMITEDBMUMBAI") while the start stays put. Known
 * brands are left out on both sides: the brand table already groups their
 * spellings, and a bare "RELIANCE" must not take Reliance Digital and
 * Reliance Trends together. Two keys of one name that share only a stem
 * nobody printed alone stay apart.
 */
function groupKeys(txns: LabelledTxn[]): Map<string, string> {
  const stems = new Set<string>();
  for (const txn of txns) {
    if (!isBrand(txn.merchant) && txn.merchantKey.length >= MIN_STEM)
      stems.add(txn.merchantKey);
  }
  const groups = new Map<string, string>();
  for (const key of stems) {
    let group = key;
    for (let len = MIN_STEM; len < key.length; len++) {
      if (stems.has(key.slice(0, len))) {
        group = key.slice(0, len);
        break;
      }
    }
    groups.set(key, group);
  }
  return groups;
}

/** Puts every transaction in its merchant's group (`groupKeys`) and gives it
 * the group's name: the most common spelling of the group's own key (the
 * shortest, so the one with the least noise on its end); on a tie, the one
 * with more spaces (words read better than "TATAPAYMENTS"). */
function withGroupNames(labelled: LabelledTxn[]): LabelledTxn[] {
  const groups = groupKeys(labelled);
  const txns = labelled.map((txn) => ({
    ...txn,
    merchantKey: groups.get(txn.merchantKey) ?? txn.merchantKey,
  }));
  const counts = new Map<string, Map<string, number>>();
  txns.forEach((txn, i) => {
    // The group's key is always some line's own key, so it always has a name.
    if (labelled[i].merchantKey !== txn.merchantKey) return;
    const names = counts.get(txn.merchantKey) ?? new Map<string, number>();
    names.set(txn.merchant, (names.get(txn.merchant) ?? 0) + 1);
    counts.set(txn.merchantKey, names);
  });
  const spaces = (name: string) => name.split(' ').length;
  const chosen = new Map<string, string>();
  for (const [key, names] of counts) {
    const [best] = [...names].sort(
      (a, b) =>
        b[1] - a[1] || spaces(b[0]) - spaces(a[0]) || a[0].localeCompare(b[0]),
    );
    chosen.set(key, best[0]);
  }
  return txns.map((txn) => ({
    ...txn,
    merchant: chosen.get(txn.merchantKey)!,
  }));
}

/** Rounds a sum of rupee amounts to paise, so float drift never shows. */
function paise(value: number): number {
  return Math.round(value * 100) / 100;
}

export type RangeChoice = '3' | '12' | 'all';

export const RANGE_CHOICES: RangeChoice[] = ['3', '12', 'all'];

/** The billing months a range covers, oldest and newest inclusive. */
export interface PeriodRange {
  from: string;
  to: string;
}

/**
 * The months a range choice covers: that many billing months back from the
 * newest statement among `periods` (the data may be months old, so it's
 * never counted from today). A month with no statement still counts, so
 * the page states how many statements the range holds. Null when there are
 * no statements.
 */
export function resolveRange(
  periods: string[],
  choice: RangeChoice,
): PeriodRange | null {
  if (periods.length === 0) return null;
  const sorted = [...periods].sort();
  const to = sorted[sorted.length - 1];
  if (choice === 'all') return { from: sorted[0], to };
  let from = to;
  for (let i = 1; i < Number(choice); i++) from = previousPeriod(from);
  // Never claim months before the first statement.
  return { from: from < sorted[0] ? sorted[0] : from, to };
}

function inRange(period: string, range: PeriodRange): boolean {
  return period >= range.from && period <= range.to;
}

// ── Where it went ──────────────────────────────────────────────────────

export interface MerchantTotal {
  merchant: string;
  /** Purchases minus that merchant's refunds (positive = money out). */
  net: number;
  purchases: number; // number of purchase lines
  /** The purchase and refund lines behind `net`, newest first. */
  lines: LabelledTxn[];
}

export interface WhereItWent {
  merchants: MerchantTotal[]; // largest first, net > 0 only
  largest: LabelledTxn[]; // largest purchases first
  /** Net purchases across every merchant (the base of the shares). */
  total: number;
}

/** Top merchants net of their refunds, and the largest single purchases.
 * Only purchase and refund lines count: fees, interest and EMIs are the
 * card's cost (see `whatItCosts`), payments and cashback aren't spending. */
export function whereItWent(
  txns: LabelledTxn[],
  limits = { merchants: 8, largest: 5 },
): WhereItWent {
  const byMerchant = new Map<string, MerchantTotal>();
  const purchases: LabelledTxn[] = [];
  let total = 0;
  for (const txn of txns) {
    if (txn.kind !== 'purchase' && txn.kind !== 'refund') continue;
    const entry = byMerchant.get(txn.merchantKey) ?? {
      merchant: txn.merchant,
      net: 0,
      purchases: 0,
      lines: [],
    };
    entry.net -= txn.amount;
    entry.lines.push(txn);
    total -= txn.amount;
    if (txn.kind === 'purchase') {
      entry.purchases += 1;
      // A purchase line names the merchant better than a refund line does.
      entry.merchant = txn.merchant;
      purchases.push(txn);
    }
    byMerchant.set(txn.merchantKey, entry);
  }
  const merchants = [...byMerchant.values()]
    .map((m) => ({
      ...m,
      net: paise(m.net),
      lines: m.lines.sort((a, b) => b.dateISO.localeCompare(a.dateISO)),
    }))
    .filter((m) => m.net > 0 && m.purchases > 0)
    .sort((a, b) => b.net - a.net || a.merchant.localeCompare(b.merchant))
    .slice(0, limits.merchants);
  const largest = purchases
    .sort((a, b) => a.amount - b.amount || b.dateISO.localeCompare(a.dateISO))
    .slice(0, limits.largest);
  return { merchants, largest, total: paise(total) };
}

// ── Subscriptions ──────────────────────────────────────────────────────

export interface Subscription {
  cardId: string;
  merchant: string;
  cadence: 'monthly' | 'yearly';
  amount: number; // the latest charge, positive
  /** The charge before it, when the price went up (> ₹10 and > 5%). */
  previousAmount?: number;
  since: string; // billing month of the first charge in the run
  lastPeriod: string; // billing month of the latest charge
}

/** Amounts within this share of each other are "the same charge". */
const SIMILAR = 0.15;
/** A price change up to this factor, either way, is still the same
 * subscription; beyond it, it's a different purchase. */
const MAX_CHANGE = 2;

function similar(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * SIMILAR;
}

function plausibleChange(was: number, now: number): boolean {
  return now / was <= MAX_CHANGE && was / now <= MAX_CHANGE;
}

/** A rise worth mentioning: more than ₹10 AND more than 5% — rounding and
 * exchange-rate wobble on a foreign subscription stay quiet. */
export function isPriceRise(previous: number, latest: number): boolean {
  const rise = latest - previous;
  return rise > 10 && rise > previous * 0.05;
}

function monthsApart(older: string, newer: string): number {
  const [y1, m1] = older.split('-').map(Number);
  const [y2, m2] = newer.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

/**
 * Recurring charges on each card, judged over the card's whole history (a
 * short range would hide them) and listed only while still running.
 *
 * - Monthly: one charge in each of at least 3 consecutive billing months,
 *   ending in the card's newest month or the one before (a bill can post a
 *   day late), all at one price (within 15%) — or at a new price after at
 *   least two charges at a settled old one, up to double or half of it.
 *   "Since" is the start of the old price, when there was one.
 * - Yearly: the last two charges 11–13 months apart with nothing between,
 *   the latest within the last 12 months.
 * A month with two charges from the merchant breaks a run: that's shopping,
 * not a subscription.
 */
export function findSubscriptions(
  txns: LabelledTxn[],
  statementPeriods: Map<string, Set<string>>,
): Subscription[] {
  const groups = new Map<string, LabelledTxn[]>();
  for (const txn of txns) {
    if (txn.kind !== 'purchase') continue;
    const key = `${txn.cardId}|${txn.merchantKey}`;
    const list = groups.get(key) ?? [];
    list.push(txn);
    groups.set(key, list);
  }

  const found: Subscription[] = [];
  for (const charges of groups.values()) {
    const cardId = charges[0].cardId;
    const periods = statementPeriods.get(cardId) ?? new Set<string>();
    const newest = [...periods].sort().pop();
    if (newest === undefined) continue;

    const byPeriod = new Map<string, LabelledTxn[]>();
    for (const c of charges) {
      const list = byPeriod.get(c.period) ?? [];
      list.push(c);
      byPeriod.set(c.period, list);
    }
    const chargedPeriods = [...byPeriod.keys()].sort();
    const last = chargedPeriods[chargedPeriods.length - 1];
    if ((byPeriod.get(last) ?? []).length !== 1) continue;
    const latest = byPeriod.get(last)![0];
    const amountOf = (period: string) => -byPeriod.get(period)![0].amount;

    // Monthly: walk back from the latest charge while each earlier month
    // has exactly one charge.
    const run = [last];
    for (
      let p = previousPeriod(last);
      byPeriod.get(p)?.length === 1;
      p = previousPeriod(p)
    ) {
      run.unshift(p);
    }
    const sub = (
      cadence: Subscription['cadence'],
      runPeriods: string[],
      minCharges: number,
    ): Subscription | null => {
      const amounts = runPeriods.map(amountOf);
      const amount = amounts[amounts.length - 1];
      // Today's price: the charges at the end of the run close to the latest.
      let cur = amounts.length - 1;
      while (cur > 0 && similar(amounts[cur - 1], amount)) cur -= 1;
      // The price before a change, when it was settled at its own level.
      let old = cur;
      const was = cur > 0 ? amounts[cur - 1] : undefined;
      if (was !== undefined && plausibleChange(was, amount)) {
        old = cur - 1;
        while (old > 0 && similar(amounts[old - 1], was)) old -= 1;
      }
      const currentCount = amounts.length - cur;
      const oldCount = cur - old;
      // A monthly price change needs two charges at the old price, so
      // amounts that merely wander never pass as a subscription.
      const settledBefore = oldCount >= Math.max(1, minCharges - 1);
      if (currentCount < minCharges && !settledBefore) return null;
      const since = runPeriods[settledBefore ? old : cur];
      return {
        cardId,
        merchant: latest.merchant,
        cadence,
        amount,
        // "Up from" only while the new price is recent.
        previousAmount:
          settledBefore &&
          was !== undefined &&
          currentCount < 3 &&
          isPriceRise(was, amount)
            ? was
            : undefined,
        since,
        lastPeriod: last,
      };
    };

    if (run.length >= 3 && monthsApart(last, newest) <= 1) {
      const monthly = sub('monthly', run, 3);
      if (monthly !== null) {
        found.push(monthly);
        continue;
      }
    }
    if (chargedPeriods.length >= 2 && monthsApart(last, newest) < 12) {
      const prior = chargedPeriods[chargedPeriods.length - 2];
      const gap = monthsApart(prior, last);
      if (gap >= 11 && gap <= 13 && byPeriod.get(prior)!.length === 1) {
        const yearly = sub('yearly', [prior, last], 2);
        if (yearly !== null) found.push(yearly);
      }
    }
  }
  return found.sort(
    (a, b) =>
      (a.cadence === b.cadence ? 0 : a.cadence === 'monthly' ? -1 : 1) ||
      b.amount - a.amount ||
      a.merchant.localeCompare(b.merchant),
  );
}

/** What the monthly subscriptions add to every bill. */
export function monthlyCommitted(subs: Subscription[]): number {
  return paise(
    subs
      .filter((s) => s.cadence === 'monthly')
      .reduce((sum, s) => sum + s.amount, 0),
  );
}

// ── What it costs ──────────────────────────────────────────────────────

/** The rows of "What it costs", in display order. Fee lines are split
 * three ways so the annual fee can be eyeballed: GST (any fee line naming
 * GST, including "GST ON ANNUAL FEE": the tax is its own figure), the
 * annual fee (lib/charges.ts classifyCharge's 'annual-fee', e.g.
 * "RENEWAL MEMBERSHIP FEE"), and every other fee. */
export const COST_KINDS = [
  'annualFee',
  'otherFees',
  'gst',
  'interest',
  'forexMarkup',
  'cashback',
] as const;

export type CostKind = (typeof COST_KINDS)[number];

export interface CardCosts {
  /** Net per row, positive = money out (a cost), negative = money back:
   * waivers beyond their charges, and cashback (always negative or 0). */
  amounts: Record<CostKind, number>;
  /** Everything but cashback: what the card cost, net of waivers. */
  charges: number;
  /** The lines behind each figure, oldest first, so the user can see which
   * fee it was. EMI lines are in none of them: an EMI is a purchase paid in
   * parts, not the card's own cost. */
  lines: Record<CostKind, LabelledTxn[]>;
}

/** A GST line starts with it ("IGST ON LATE FEE", "IGST-VPS…-RATE 18.0",
 * "CGST"); a fee that merely mentions it ("ANNUAL FEE (INCL GST)") is the
 * fee. */
const GST_LINE = /^[^A-Z]*[CSI]?GST\b/i;

function costKind(txn: LabelledTxn): CostKind | null {
  switch (txn.kind) {
    case 'fee':
      if (GST_LINE.test(txn.payee)) return 'gst';
      return classifyCharge(txn.payee) === 'annual-fee'
        ? 'annualFee'
        : 'otherFees';
    case 'interest':
      return 'interest';
    case 'forex-markup':
      return 'forexMarkup';
    case 'cashback':
      return 'cashback';
    default:
      return null;
  }
}

export function whatItCosts(txns: LabelledTxn[]): CardCosts {
  const lines = Object.fromEntries(
    COST_KINDS.map((kind) => [kind, [] as LabelledTxn[]]),
  ) as Record<CostKind, LabelledTxn[]>;
  for (const txn of txns) {
    const kind = costKind(txn);
    if (kind !== null) lines[kind].push(txn);
  }
  // A waiver that doesn't name its fee ("FEE WAIVER") nets against the
  // annual fee it matches to the paisa, so neither row misleads alone.
  const annualCharges = new Set(
    lines.annualFee.filter((t) => t.amount < 0).map((t) => -t.amount),
  );
  lines.otherFees = lines.otherFees.filter((t) => {
    if (t.amount <= 0 || !annualCharges.has(t.amount)) return true;
    lines.annualFee.push(t);
    return false;
  });
  const amounts = {} as Record<CostKind, number>;
  for (const kind of COST_KINDS) {
    lines[kind].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
    // 0 - x: a row with nothing in it is 0, never -0.
    amounts[kind] =
      0 - paise(lines[kind].reduce((sum, t) => sum + t.amount, 0));
  }
  const charges = paise(
    COST_KINDS.filter((k) => k !== 'cashback').reduce(
      (sum, k) => sum + amounts[k],
      0,
    ),
  );
  return { amounts, charges, lines };
}

// ── Credit used ────────────────────────────────────────────────────────

export interface CreditUse {
  cardId: string;
  period: string;
  totalDue: number;
  creditLimit: number;
  /** totalDue ÷ creditLimit, 0–1 (can exceed 1 when over the limit). */
  ratio: number;
}

/** Utilisation above this gets a gentle note: lenders read a high share of
 * the limit in use as stretched credit. */
export const HIGH_UTILISATION = 0.3;

/** Each card's newest statement in the range that states both a total due
 * and a credit limit. A card whose newest statement lacks either is left
 * out rather than answered from an older one. */
export function creditUsed(
  statements: StatementRecord[],
  range: PeriodRange,
): CreditUse[] {
  const newest = new Map<string, StatementRecord>();
  for (const s of statements) {
    if (!inRange(s.period, range)) continue;
    const current = newest.get(s.cardId);
    if (current === undefined || s.period > current.period)
      newest.set(s.cardId, s);
  }
  const out: CreditUse[] = [];
  for (const s of newest.values()) {
    if (s.totalDue === undefined || s.creditLimit === undefined) continue;
    if (!(s.creditLimit > 0) || !Number.isFinite(s.totalDue)) continue;
    out.push({
      cardId: s.cardId,
      period: s.period,
      totalDue: s.totalDue,
      creditLimit: s.creditLimit,
      ratio: Math.max(0, s.totalDue) / s.creditLimit,
    });
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

// ── Possible duplicates ────────────────────────────────────────────────

export interface DuplicateGroup {
  cardId: string;
  merchant: string;
  dateISO: string;
  amount: number; // each charge, positive
  count: number;
}

/** How long after a charge its reversal can post: a refund this many days
 * later, or fewer, can be the one that cancels it. */
const REVERSAL_DAYS = 7;

/** Purchases on the same card, from the same merchant, for the same amount,
 * on the same day. Two coffees in a morning look the same, so these are
 * "possible" duplicates for the user to check, never removed. A refund of
 * that amount from that merchant, on the day or up to a week later, cancels
 * one of them (a charge taken twice and reversed once is one charge); it
 * goes to the nearest charge day before it, and a group is listed only while
 * two or more charges remain. */
export function possibleDuplicates(txns: LabelledTxn[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  const refunds: LabelledTxn[] = [];
  for (const txn of txns) {
    if (txn.kind === 'refund') refunds.push(txn);
    if (txn.kind !== 'purchase') continue;
    const key = [txn.cardId, txn.merchantKey, txn.dateISO, txn.amount].join(
      '|',
    );
    const group = groups.get(key) ?? {
      cardId: txn.cardId,
      merchant: txn.merchant,
      dateISO: txn.dateISO,
      amount: -txn.amount,
      count: 0,
    };
    group.count += 1;
    groups.set(key, group);
  }
  // In date order, so an earlier refund claims its charge first.
  refunds.sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  for (const refund of refunds) {
    let nearest: DuplicateGroup | undefined;
    for (let back = 0; back <= REVERSAL_DAYS && nearest === undefined; back++) {
      const dateISO = addDaysISO(refund.dateISO, -back);
      const group = groups.get(
        [refund.cardId, refund.merchantKey, dateISO, -refund.amount].join('|'),
      );
      if (group !== undefined && group.count > 0) nearest = group;
    }
    if (nearest !== undefined) nearest.count -= 1;
  }
  return [...groups.values()]
    .filter((g) => g.count > 1)
    .sort((a, b) => b.dateISO.localeCompare(a.dateISO) || b.amount - a.amount);
}

// ── The page ───────────────────────────────────────────────────────────

export interface Insights {
  range: PeriodRange;
  /** Billing months in the range that have a statement on a selected card. */
  statementCount: number;
  whereItWent: WhereItWent;
  subscriptions: Subscription[];
  committed: number;
  costs: CardCosts;
  credit: CreditUse[];
  duplicates: DuplicateGroup[];
}

/** Everything the Insights page shows for one card (or all, `cardId`
 * undefined) over a range. Null when the selection has no statements. */
export function buildInsights(
  input: InsightsInput,
  choice: RangeChoice,
  cardId?: string,
): Insights | null {
  const selected =
    cardId === undefined
      ? input
      : {
          cards: input.cards.filter((c) => c.id === cardId),
          statements: input.statements.filter((s) => s.cardId === cardId),
          transactions: input.transactions.filter((t) => t.cardId === cardId),
          cycles: input.cycles.filter((c) => c.cardId === cardId),
        };
  const known = new Set(selected.cards.map((c) => c.id));
  const statements = selected.statements.filter((s) => known.has(s.cardId));
  const range = resolveRange(
    statements.map((s) => s.period),
    choice,
  );
  if (range === null) return null;

  const all = labelTransactions(selected);
  const txns = all.filter((t) => inRange(t.period, range));
  const statementPeriods = new Map<string, Set<string>>();
  for (const s of statements) {
    const set = statementPeriods.get(s.cardId) ?? new Set<string>();
    set.add(s.period);
    statementPeriods.set(s.cardId, set);
  }
  const subscriptions = findSubscriptions(all, statementPeriods);
  return {
    range,
    statementCount: statements.filter((s) => inRange(s.period, range)).length,
    whereItWent: whereItWent(txns),
    subscriptions,
    committed: monthlyCommitted(subscriptions),
    costs: whatItCosts(txns),
    credit: creditUsed(statements, range),
    duplicates: possibleDuplicates(txns),
  };
}
