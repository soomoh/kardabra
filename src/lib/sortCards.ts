/**
 * The dashboard's tile order. Pure function over plain data (no DB, no
 * component) so ordering rules can be pinned down with tests independent
 * of how CardTile renders.
 *
 * Priority (most to least urgent — the whole point of a dashboard is
 * surfacing what needs attention first):
 *   1. unpaid, due date known — earliest due date first
 *   2. unpaid, due date unknown
 *   3. paid
 *   4. no cycle imported yet at all
 * Ties within a group keep their relative input order (Array.prototype.sort
 * is a stable sort as of ES2019, so this needs no explicit tiebreaker).
 */

import type { CardRecord, CycleRecord } from '../db/schema';
import { cycleNeedsPayment } from './cycles';

export interface CardWithCycle {
  card: CardRecord;
  cycle: CycleRecord | null;
}

/** Lower number sorts first. A plain numbered table (data over code)
 * rather than an if/elif chain repeated at each call site.
 * "Needs no payment" (paid, ₹0 bill, no-spend cycle — one predicate, see
 * lib/cycles.ts) all rank together in the calm group: a zero-due card is
 * exactly as un-urgent as a paid one. */
function groupRank(cycle: CycleRecord | null): 0 | 1 | 2 | 3 {
  if (cycle === null) return 3;
  if (!cycleNeedsPayment(cycle)) return 2;
  if (cycle.dueDateISO === null) return 1;
  return 0;
}

export function sortDashboardCards(entries: CardWithCycle[]): CardWithCycle[] {
  return [...entries].sort((a, b) => {
    const rankDiff = groupRank(a.cycle) - groupRank(b.cycle);
    if (rankDiff !== 0) return rankDiff;

    // Only group 0 (unpaid, known due date) needs a secondary key —
    // every other group's members are equally-ranked by definition.
    if (groupRank(a.cycle) === 0) {
      // Non-null asserted: groupRank 0 only happens when cycle and its
      // dueDateISO are both non-null (see groupRank above).
      return a.cycle!.dueDateISO!.localeCompare(b.cycle!.dueDateISO!);
    }
    return 0;
  });
}
