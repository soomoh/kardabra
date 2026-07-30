/**
 * Pure calendar-field math on 'YYYY-MM-DD' strings.
 *
 * Every function here works on year/month/day as plain numbers, not on
 * elapsed time — there's no "add N milliseconds and see what date falls
 * out" anywhere below. That distinction matters once daylight saving is
 * in play: this app is IST-only (India has no DST, so in practice nothing
 * here would misbehave from that alone), but the *pattern* of doing
 * calendar arithmetic by adding milliseconds to a timestamp is a general
 * landmine (a wall-clock day can be 23 or 25 hours long across a DST
 * boundary elsewhere), so it's avoided on principle rather than relied on
 * being safe by accident. Where a numeric day-count is genuinely needed
 * (`daysBetweenISO`), the code uses `Date.UTC` specifically *because* UTC
 * has no DST at all, sidestepping the whole issue rather than reasoning
 * through it.
 */

/** Build 'YYYY-MM-DD' from calendar-field parts, zero-padded. */
function isoFromParts(year: number, month: number, day: number): string {
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function partsFromISO(iso: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

/**
 * The last real day of `month` in `year` (1-indexed month), so a
 * requested `day` beyond it clamps down to it instead of overflowing into
 * the next month. `clampDayToMonth(2025, 2, 31)` -> 28; `clampDayToMonth(
 * 2024, 2, 31)` -> 29 (2024 is a leap year) — the real Gregorian leap-year
 * rule, not a fixed "28 or 30" table, because `Date.UTC`/`getUTCDate`
 * already implement it correctly.
 */
export function clampDayToMonth(
  year: number,
  month: number,
  day: number,
): number {
  // Date.UTC(year, month, 0) is "day 0 of `month`" in JS's 0-indexed month
  // numbering — which, since `month` here is passed as the 1-indexed
  // calendar month, lands on the *last* day of that same calendar month
  // (day 0 of "March" 0-indexed is the last day of February).
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(day, lastDayOfMonth);
}

/**
 * The first calendar date with day-of-month `dueDay` that falls strictly
 * after `afterISO` — same month if `dueDay` hasn't happened yet that
 * month, otherwise the next month, each clamped via `clampDayToMonth`.
 *
 * This is the "ask once" projection: a card whose statements never state
 * a due date (ICICI) instead has a user-supplied `dueDay` on the
 * CardRecord, and every cycle's due date is computed from it relative to
 * that cycle's statement date. E.g. statement dated 2025-11-13 with
 * `dueDay` 1 -> '2025-12-01' (the 1st has already passed this month, so
 * it rolls to next month).
 */
export function nextDueDateISO(afterISO: string, dueDay: number): string {
  const { year, month, day } = partsFromISO(afterISO);

  const sameMonthDay = clampDayToMonth(year, month, dueDay);
  if (sameMonthDay > day) {
    return isoFromParts(year, month, sameMonthDay);
  }

  // dueDay has already happened (or is today) this month — roll to next
  // month, wrapping December into January of the following year.
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonthDay = clampDayToMonth(nextYear, nextMonth, dueDay);
  return isoFromParts(nextYear, nextMonth, nextMonthDay);
}

/**
 * Like nextDueDateISO, but the projected due date must be at least
 * `minGapDays` after the anchor. Banks give 15–25 interest-free days
 * between statement generation and payment due; a projected due date 2–3
 * days after the anchor is therefore always a mis-projection, typically
 * because the anchor is the last *transaction* date standing in for an
 * unknown statement date. Example: last txn 19 May with due-day 22
 * naively projects "due 22 May" — only three days later — when the bank
 * actually meant 22 June. Skipping any occurrence closer than
 * `minGapDays` lands on the month the bank actually meant.
 */
export function nextDueDateWithGraceISO(
  anchorISO: string,
  dueDay: number,
  minGapDays = 10,
): string {
  let candidate = nextDueDateISO(anchorISO, dueDay);
  while (daysBetweenISO(anchorISO, candidate) < minGapDays) {
    candidate = nextDueDateISO(candidate, dueDay);
  }
  return candidate;
}

/** `bISO` minus `aISO`, in whole days (can be negative if `bISO` is
 * earlier). Uses `Date.UTC` — treating both dates as midnight UTC rather
 * than midnight in some local timezone — specifically so the subtraction
 * is always an exact multiple of 24 hours; a local-time `Date` could be
 * off by an hour around a DST transition elsewhere, silently rounding a
 * day-count down by one. */
export function daysBetweenISO(aISO: string, bISO: string): number {
  const a = partsFromISO(aISO);
  const b = partsFromISO(bISO);
  const msPerDay = 24 * 60 * 60 * 1000;
  const aMs = Date.UTC(a.year, a.month - 1, a.day);
  const bMs = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((bMs - aMs) / msPerDay);
}

/**
 * Today's date as 'YYYY-MM-DD', in India Standard Time regardless of the
 * machine's own timezone — the app is IST-only, so "today" must mean the
 * same calendar day for every user no matter where the device thinks it
 * is. `Intl.DateTimeFormat('en-CA', ...)` is the trick: the en-CA
 * (Canadian English) locale happens to format dates as 'YYYY-MM-DD', so
 * asking it to format `now` in the 'Asia/Kolkata' timezone hands back
 * exactly the string this function needs, with no manual date-math at
 * all.
 */
export function todayISO(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(),
  );
}

/**
 * Display formatters — ISO stays the internal storage/sort format (it
 * sorts lexicographically and needs no timezone reasoning), but every
 * user-facing label uses Indian conventions, never the US month-first
 * order. A billing period 'YYYY-MM' -> 'MM-YYYY'; a full date
 * 'YYYY-MM-DD' -> 'DD-MM-YYYY'. Both are pure string re-orderings of our
 * own well-formed ISO values; anything that doesn't match the shape is
 * returned unchanged rather than mangled (defensive, shouldn't occur).
 */
export function formatPeriodLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (match === null) return period;
  const [, year, month] = match;
  return `${month}-${year}`;
}

export function formatDateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return iso;
  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
}
