/**
 * The dashboard headline's unpaid totals, as a pure function so the "which
 * cycles count as unpaid, and when may we print a sum" decisions are
 * testable without a DOM (test the seam, not the surface).
 *
 * The entries passed in are one-per-card, each carrying that card's
 * *actionable* cycle only (lib/cycles.ts actionableCycle) — so settled-by-
 * successor history can never inflate this count or sum by construction;
 * see lib/cycles.ts for the domain rule.
 */

import type { CycleRecord } from '../db/schema';
import type { CardWithCycle } from './sortCards';
import { cycleNeedsPayment } from './cycles';

/** The unpaid bills across all cards, as numbers: what the dashboard's
 * headline is built from. `total` is null when some unpaid cycle has
 * neither a bill nor a spend figure — a partial sum must not pass for the
 * total. */
export interface UnpaidTotals {
  count: number;
  total: number | null;
  isEstimate: boolean;
}

export function unpaidTotals(entries: CardWithCycle[]): UnpaidTotals {
  // cycleNeedsPayment, not a bare paidAt check: a ₹0 bill or a no-spend
  // cycle isn't "unpaid", it's simply not owed (see lib/cycles.ts).
  const unpaidCycles = entries
    .map((entry) => entry.cycle)
    .filter((cycle): cycle is CycleRecord => cycle !== null)
    .filter((cycle) => cycleNeedsPayment(cycle));

  const amounts = unpaidCycles.map((cycle) => cycle.totalDue ?? cycle.spend);
  const total = amounts.some((amount) => amount === undefined)
    ? null
    : amounts.reduce((sum: number, a) => sum + (a ?? 0), 0);
  return {
    count: unpaidCycles.length,
    total,
    isEstimate: unpaidCycles.some((cycle) => cycle.totalDue === undefined),
  };
}
