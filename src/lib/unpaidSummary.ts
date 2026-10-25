/**
 * The dashboard header's one-line total, extracted from Dashboard.tsx
 * into a pure function so the "which cycles count as unpaid, and when
 * may we print a sum" decisions are testable without a DOM (test the
 * seam, not the surface).
 *
 * The entries passed in are one-per-card, each carrying that card's
 * *actionable* cycle only (lib/cycles.ts actionableCycle) — so settled-by-
 * successor history can never inflate this count or sum by construction;
 * see lib/cycles.ts for the domain rule.
 */

import type { CycleRecord } from '../db/schema';
import type { CardWithCycle } from './sortCards';
import { cycleNeedsPayment } from './cycles';
import { formatINR } from './money';

/** 'X unpaid · ₹Y due' — the birds-eye total across all cards.
 *
 * Per-cycle amount: the bank's own totalDue when the statement carried
 * one, else the cycle's computed spend (a good stand-in for the bill
 * when the user pays in full — see CardTile's comment on when they can
 * diverge). When any card contributed a spend-substituted figure the
 * total is prefixed '~': an estimate presented as an estimate. Only a
 * cycle with NEITHER figure (rare: an old import from before spend was
 * recorded) suppresses the amount clause entirely — a partial sum
 * presented as "the total" is worse than no total at all, the same
 * sentinels-are-not-zero reasoning as CardTile's own "Amount unknown". */
export function unpaidSummary(entries: CardWithCycle[]): string {
  // cycleNeedsPayment, not a bare paidAt check: a ₹0 bill or a no-spend
  // cycle isn't "unpaid", it's simply not owed (see lib/cycles.ts).
  const unpaidCycles = entries
    .map((entry) => entry.cycle)
    .filter((cycle): cycle is CycleRecord => cycle !== null)
    .filter((cycle) => cycleNeedsPayment(cycle));

  if (unpaidCycles.length === 0) return 'All caught up';

  const amounts = unpaidCycles.map((cycle) => cycle.totalDue ?? cycle.spend);
  if (amounts.some((amount) => amount === undefined)) {
    return `${unpaidCycles.length} unpaid`;
  }

  const total = amounts.reduce((sum: number, a) => sum + (a ?? 0), 0);
  const isEstimate = unpaidCycles.some((cycle) => cycle.totalDue === undefined);
  const prefix = isEstimate ? '~' : '';
  return `${unpaidCycles.length} unpaid · ${prefix}${formatINR(total)} due`;
}
