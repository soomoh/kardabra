/**
 * Turns real statement text into synthetic text with the same *shape*.
 *
 * Contract (what downstream parsers can rely on): dates keep their exact
 * format and all move by one secret whole-day offset; amounts keep their
 * format (grouping style, decimals, sign, Cr/Dr, currency prefix) and are all
 * scaled by one secret factor; masked card numbers keep their mask and first
 * four digits (the issuer prefix) with the rest faked consistently; every
 * other digit run is randomised at the same length; every word not in
 * VOCABULARY becomes a same-length, same-case pseudo-word. The same input
 * token always maps to the same output within one Anonymizer, so repeated
 * merchants and card numbers stay recognisable as repeats.
 *
 * The offset, factor and mappings never leave this object — they are the key
 * to reversing the output, so nothing here exposes them.
 */

import type { DateOrder } from '../parser';
import { isStructuralWord } from './vocabulary';

export interface Anonymizer {
  /** Anonymize free text (a CSV cell, a spreadsheet string, a PDF line). */
  text(value: string): string;
  /** A whole cell that is just a number: scaled like an amount, unless it is
   * too large to be money (then it's an identifier and gets fake digits). */
  number(value: number): number;
  /** A spreadsheet date serial (days since 1899-12-30), shifted. */
  dateSerial(value: number): number;
  /** Distinct inputs that contained letters and came out unchanged — the
   * short list a human reviews before sharing. */
  keptVerbatim(): string[];
  /** Vocabulary words kept inside text that otherwise changed ("JUNE" in
   * "JUNE XAVOTE"). Listed separately so a name that happens to be a
   * structural word (June, May, First…) is still in front of the reviewer. */
  keptWords(): string[];
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const MONTH_RE =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';

// One alternation, tried left to right at each position, so every character
// is claimed by exactly one rule: a date's digits are never re-randomised as
// "digits", and a card number's digits are never scaled as an amount.
// Order is by specificity — dates and cards before amounts before bare digits.
const TOKEN_RE = new RegExp(
  [
    String.raw`(?<iso>\b\d{4}-\d{1,2}-\d{1,2}\b)`,
    String.raw`(?<dmy>\b\d{1,2}(?<sep>[/-])\d{1,2}\k<sep>(?:\d{4}|\d{2})\b)`,
    String.raw`(?<dmon>\b\d{1,2}[ -](?:${MONTH_RE})\.?,?[ -]'?(?:\d{4}|\d{2})\b)`,
    String.raw`(?<mond>\b(?:${MONTH_RE})\.? \d{1,2}, \d{4}\b)`,
    String.raw`(?<mony>\b(?:${MONTH_RE}) \d{4}\b)`,
    // Masked card number: 4 digits, then digits/spaces/dashes including at
    // least one mask character, ending in digits ("4823 41XX XXXX 4321").
    String.raw`(?<card>\b\d{4}(?=[\d \-]*[Xx*])[\d \-Xx*]*?\d{2,4}\b)`,
    // Fully masked except the last digits ("XXXX XXXX XXXX XX34", SBI).
    String.raw`(?<maskedCard>(?<![\p{L}\d*])[Xx*]{4}(?:[ \-]?[Xx*]{2,4}){1,3}[ \-]?\d{2,4}(?![\p{L}\d]))`,
    // Amounts: grouped ("1,23,456.00"), decimal ("925.65"), or a whole
    // number right after a currency marker ("INR 0", "₹ 2500").
    String.raw`(?<amount>(?<![\d.,])\d{1,3}(?:,\d{2,3})+(?:\.\d+)?(?![\d,])|(?<![\d.,])\d+\.\d{1,2}(?![\d.])|(?<=(?:₹|\bRs\.?|\bINR)\s?)\d+(?![\d.,]))`,
    String.raw`(?<digits>\d+)`,
    String.raw`(?<word>\p{L}+)`,
  ].join('|'),
  'gu',
);

const VOWELS = 'aeiou';
const CONSONANTS = 'bcdfghjklmnprstvz';

/** Deterministic PRNG (mulberry32) — seeded once per Anonymizer. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function isoToUtc(y: number, m: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
    ? date
    : null;
}

function monthIndex(name: string): number {
  const lower = name.toLowerCase().replace(/\.$/, '');
  return MONTHS.findIndex((m) => m.startsWith(lower.slice(0, 3)));
}

/** Render month `index` in the style of `like` (case and abbreviation). */
function monthLike(index: number, like: string): string {
  const full = MONTHS[index];
  const bare = like.replace(/\.$/, '').toLowerCase();
  const abbreviated = bare.length === 3 || bare === 'sept';
  return applyCase(abbreviated ? full.slice(0, 3) : full, like);
}

function applyCase(word: string, like: string): string {
  if (like === like.toUpperCase()) return word.toUpperCase();
  if (like[0] === like[0].toUpperCase())
    return word[0].toUpperCase() + word.slice(1);
  return word;
}

/** Group an integer string the way `like` was grouped (Indian lakh "1,23,456"
 * vs western "123,456" vs none). */
function groupLike(intPart: string, like: string): string {
  if (!like.includes(',')) return intPart;
  const groups = like.split(',');
  const lakh =
    groups.length > 2 || (groups.length === 2 && groups[0].length > 3)
      ? groups.slice(1, -1).some((g) => g.length === 2)
      : false;
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  let rest = intPart.slice(0, -3);
  const step = lakh ? 2 : 3;
  const parts: string[] = [];
  while (rest.length > step) {
    parts.unshift(rest.slice(-step));
    rest = rest.slice(0, -step);
  }
  if (rest) parts.unshift(rest);
  return [...parts, last3].join(',');
}

/** `dateOrder`: how the file writes numeric dates (see parser inferDateOrder);
 * day-first by default. */
export function createAnonymizer(
  seed: number = randomSeed(),
  dateOrder: DateOrder = 'dmy',
): Anonymizer {
  const rand = prng(seed);
  // Offset: 30–400 days back; factor: 0.55–1.45, never ~1.
  const offsetDays = -(30 + Math.floor(rand() * 371));
  let factor = 0.55 + rand() * 0.9;
  if (Math.abs(factor - 1) < 0.08) factor += 0.15;
  const offsetMs = offsetDays * 86_400_000;

  const wordMap = new Map<string, string>();
  const digitMap = new Map<string, string>();
  const kept = new Set<string>();
  const keptWords = new Set<string>();
  let wordsThisCall: string[] = [];

  const randomDigits = (len: number, firstNonZero: boolean): string => {
    let out = '';
    for (let i = 0; i < len; i++) {
      const lo = i === 0 && firstNonZero ? 1 : 0;
      out += String(lo + Math.floor(rand() * (10 - lo)));
    }
    return out;
  };

  const fakeDigits = (digits: string): string => {
    // An all-zero run is a value ("0", "00"), not an identifier — and a zero
    // turned into a non-zero would invent a balance.
    if (/^0+$/.test(digits)) return digits;
    const hit = digitMap.get(digits);
    if (hit !== undefined) return hit;
    const out = randomDigits(digits.length, digits[0] !== '0');
    digitMap.set(digits, out);
    return out;
  };

  const pseudoWord = (word: string): string => {
    const key = word.toLowerCase();
    let base = wordMap.get(key);
    if (base === undefined) {
      do {
        base = '';
        for (let i = 0; i < key.length; i++) {
          const pool = i % 2 === 0 ? CONSONANTS : VOWELS;
          base += pool[Math.floor(rand() * pool.length)];
        }
      } while (base === key || (base.length > 1 && isStructuralWord(base)));
      wordMap.set(key, base);
    }
    // Per-character case so "McDonald" keeps its humps.
    return [...base]
      .map((ch, i) =>
        word[i] === word[i]?.toUpperCase() ? ch.toUpperCase() : ch,
      )
      .join('');
  };

  const shift = (y: number, m: number, d: number): Date | null => {
    const date = isoToUtc(y, m, d);
    return date === null ? null : new Date(date.getTime() + offsetMs);
  };

  const scaleAmount = (raw: string): string => {
    const [intRaw, frac = ''] = raw.split('.');
    const value = Number(intRaw.replace(/,/g, '') + (frac ? '.' + frac : ''));
    if (value === 0) return raw;
    const scaled = (value * factor).toFixed(frac.length);
    const [intOut, fracOut] = scaled.split('.');
    return (
      groupLike(intOut, intRaw) + (fracOut !== undefined ? '.' + fracOut : '')
    );
  };

  const year = (y: string): number =>
    y.length === 2 ? 2000 + Number(y) : Number(y);
  const yearLike = (full: number, like: string): string =>
    like.length === 2 ? pad(full % 100, 2) : String(full);

  const replaceToken = (
    match: string,
    groups: Record<string, string | undefined>,
  ): string => {
    if (groups.iso) {
      const [y, m, d] = match.split('-');
      const out = shift(Number(y), Number(m), Number(d));
      return out === null
        ? fakeDigitsIn(match)
        : `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1, m.length)}-${pad(out.getUTCDate(), d.length)}`;
    }
    if (groups.dmy) {
      const sep = groups.sep!;
      const [a, b, y] = match.split(sep);
      const [d, m] = dateOrder === 'mdy' ? [b, a] : [a, b];
      const out = shift(year(y), Number(m), Number(d));
      if (out === null) return fakeDigitsIn(match);
      const day = pad(out.getUTCDate(), d.length);
      const month = pad(out.getUTCMonth() + 1, m.length);
      const first = dateOrder === 'mdy' ? [month, day] : [day, month];
      return [...first, yearLike(out.getUTCFullYear(), y)].join(sep);
    }
    if (groups.dmon) {
      const m = /^(\d{1,2})([ -])(\p{L}+)(\.?,?)([ -])('?)(\d+)$/u.exec(match);
      const mi = m ? monthIndex(m[3]) : -1;
      const out = m && mi >= 0 ? shift(year(m[7]), mi + 1, Number(m[1])) : null;
      if (!m || out === null) return fakeDigitsIn(match);
      return `${pad(out.getUTCDate(), m[1].length)}${m[2]}${monthLike(out.getUTCMonth(), m[3])}${m[4]}${m[5]}${m[6]}${yearLike(out.getUTCFullYear(), m[7])}`;
    }
    if (groups.mond) {
      const m = /^(\p{L}+)(\.?) (\d{1,2}), (\d{4})$/u.exec(match);
      const mi = m ? monthIndex(m[1]) : -1;
      const out =
        m && mi >= 0 ? shift(Number(m[4]), mi + 1, Number(m[3])) : null;
      if (!m || out === null) return fakeDigitsIn(match);
      return `${monthLike(out.getUTCMonth(), m[1])}${m[2]} ${pad(out.getUTCDate(), m[3].length)}, ${out.getUTCFullYear()}`;
    }
    if (groups.mony) {
      const [name, y] = match.split(' ');
      const out = shift(Number(y), monthIndex(name) + 1, 15);
      if (out === null) return fakeDigitsIn(match);
      return `${monthLike(out.getUTCMonth(), name)} ${out.getUTCFullYear()}`;
    }
    if (groups.card) {
      // Keep the issuer prefix (first 4 digits) and the mask; fake the rest.
      // The trailing digits (last-4) map consistently, so the parser still
      // sees one card per real card.
      const prefix = match.slice(0, 4);
      return prefix + match.slice(4).replace(/\d+/g, (run) => fakeDigits(run));
    }
    if (groups.maskedCard) return fakeDigitsIn(match); // keep the mask
    if (groups.amount) return scaleAmount(match);
    if (groups.digits) return fakeDigits(match);
    if (groups.word) {
      if (!isStructuralWord(match)) return pseudoWord(match);
      if (match.length > 1) wordsThisCall.push(match);
      return match;
    }
    return match;
  };

  function fakeDigitsIn(s: string): string {
    return s.replace(/\d+/g, (run) => fakeDigits(run));
  }

  return {
    text(value: string): string {
      wordsThisCall = [];
      const out = value.replace(TOKEN_RE, (match, ...rest) => {
        const groups = rest.at(-1) as Record<string, string | undefined>;
        return replaceToken(match, groups);
      });
      if (out === value) {
        if (/\p{L}/u.test(value)) kept.add(value.trim());
      } else {
        for (const w of wordsThisCall) keptWords.add(w.toUpperCase());
      }
      return out;
    },
    number(value: number): number {
      if (!Number.isFinite(value) || value === 0) return value;
      if (Number.isInteger(value) && Math.abs(value) >= 1e9) {
        return Number(fakeDigits(String(Math.abs(value)))) * Math.sign(value);
      }
      const decimals = Number.isInteger(value) ? 0 : 2;
      return Number((value * factor).toFixed(decimals));
    },
    dateSerial(value: number): number {
      return value + offsetDays;
    },
    keptVerbatim(): string[] {
      return [...kept].sort();
    },
    keptWords(): string[] {
      return [...keptWords].sort();
    },
  };
}
