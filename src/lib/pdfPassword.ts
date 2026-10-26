/**
 * Candidate passwords for a bank's emailed PDF statement, built from what the
 * cardholder types once per import: name, date of birth, and (optionally) the
 * cards' last four digits. Nothing here is stored — the inputs live only as
 * long as one import run.
 *
 * Patterns are data: an id like 'name4U+ddmm' names its parts, and the id is
 * the only thing worth remembering about which one worked (it is not
 * personal). Per-bank orders follow burnrate's generator
 * (github.com/pratik-devx/burnrate @ a6c9267, Apache-2.0; see
 * THIRD_PARTY_NOTICES.md), most likely first. They are best-effort: banks
 * change conventions and third-party sources disagree, so an unknown bank
 * tries every pattern.
 */

export interface PasswordInputs {
  name: string;
  /** Date of birth. */
  dob: { day: number; month: number; year: number };
  /** Cards' last four digits, as the user knows them (SBI needs these). */
  last4s: string[];
}

export type Bank =
  'hdfc' | 'icici' | 'axis' | 'sbi' | 'federal' | 'indian_bank';

/** Pattern part -> its text. `last4` parts expand once per card. */
type Part =
  | 'name4U'
  | 'name4L'
  | 'firstU'
  | 'firstL'
  | 'ddmm'
  | 'ddmmyy'
  | 'ddmmyyyy'
  | 'last4';

const BANK_PATTERNS: Record<Bank | 'other', string[]> = {
  hdfc: [
    'name4U+ddmm',
    'name4U+last4',
    'firstU+ddmm',
    'name4U+ddmmyy',
    'name4U+ddmmyyyy',
    'firstU+ddmmyy',
    'firstU+ddmmyyyy',
    'ddmmyyyy',
    'ddmmyy',
    'name4L+ddmm',
    'firstL+ddmm',
  ],
  icici: [
    'name4L+ddmm',
    'firstL+ddmm',
    'name4L+ddmmyy',
    'firstL+ddmmyy',
    'name4L+ddmmyyyy',
    'ddmmyyyy',
    'name4U+ddmm',
  ],
  axis: [
    'name4U+ddmm',
    'firstU+ddmm',
    'name4U+ddmmyy',
    'name4U+ddmmyyyy',
    'ddmmyyyy',
    'name4L+ddmm',
  ],
  // SBI documents DOB (DDMMYYYY) + card last four as its e-statement password.
  sbi: [
    'ddmmyyyy+last4',
    'ddmmyy+last4',
    'ddmmyyyy',
    'ddmmyy',
    'name4U+ddmm',
    'firstU+ddmm',
    'name4L+ddmm',
    'firstL+ddmm',
    'name4U+ddmmyyyy',
    'firstU+ddmmyyyy',
    'name4U+last4',
    'name4L+last4',
  ],
  federal: [
    'name4U+ddmm',
    'firstU+ddmm',
    'name4U+ddmmyyyy',
    'firstU+ddmmyyyy',
    'name4L+ddmm',
    'firstL+ddmm',
    'ddmmyyyy',
    'ddmmyy',
    'name4U+last4',
    'name4L+last4',
  ],
  indian_bank: [
    'name4U+ddmm',
    'firstU+ddmm',
    'name4U+ddmmyyyy',
    'firstU+ddmmyyyy',
    'name4U+ddmmyy',
    'firstU+ddmmyy',
    'ddmmyyyy',
    'name4L+ddmm',
    'firstL+ddmm',
    'name4U+last4',
  ],
  other: [
    'name4U+ddmm',
    'name4L+ddmm',
    'firstU+ddmm',
    'firstL+ddmm',
    'name4U+ddmmyyyy',
    'name4L+ddmmyyyy',
    'ddmmyyyy',
    'ddmmyy',
    'name4U+last4',
    'name4L+last4',
  ],
};

export interface Candidate {
  /** Which pattern produced it — safe to show or keep; not personal. */
  pattern: string;
  password: string;
}

function partValues(part: Part, input: PasswordInputs): string[] {
  const letters = input.name.replace(/[^A-Za-z]/g, '');
  const first =
    input.name
      .trim()
      .split(/\s+/)[0]
      ?.replace(/[^A-Za-z]/g, '') ?? '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const { day, month, year } = input.dob;
  const ddmm = pad(day) + pad(month);
  switch (part) {
    case 'name4U':
      return [letters.slice(0, 4).toUpperCase()];
    case 'name4L':
      return [letters.slice(0, 4).toLowerCase()];
    case 'firstU':
      return [first.toUpperCase()];
    case 'firstL':
      return [first.toLowerCase()];
    case 'ddmm':
      return [ddmm];
    case 'ddmmyy':
      return [ddmm + pad(year % 100)];
    case 'ddmmyyyy':
      return [ddmm + String(year)];
    case 'last4':
      return input.last4s.filter((l) => /^\d{4}$/.test(l));
  }
}

/** Every password one pattern yields (several when it uses `last4`). */
function expand(pattern: string, input: PasswordInputs): string[] {
  let results = [''];
  for (const part of pattern.split('+') as Part[]) {
    const values = partValues(part, input);
    results = results.flatMap((r) => values.map((v) => r + v));
  }
  return results.filter((r) => r.length > 0);
}

/**
 * Candidates to try, most likely first, without duplicates. A known bank
 * tries its own patterns first, then every other bank's (conventions drift);
 * an unknown bank starts from the generic list.
 */
export function passwordCandidates(
  input: PasswordInputs,
  bank: Bank | null,
): Candidate[] {
  const order = [
    ...BANK_PATTERNS[bank ?? 'other'],
    ...Object.values(BANK_PATTERNS).flat(),
  ];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const pattern of order) {
    for (const password of expand(pattern, input)) {
      if (seen.has(password)) continue;
      seen.add(password);
      out.push({ pattern, password });
    }
  }
  return out;
}

/** Parse a typed date of birth: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, or
 * DDMMYYYY — a phone's number pad has no separators to type. */
export function parseDob(text: string): PasswordInputs['dob'] | null {
  const m =
    /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s*$/.exec(text) ??
    /^\s*(\d{2})(\d{2})(\d{4})\s*$/.exec(text);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCDate() === day && date.getUTCMonth() === month - 1
    ? { day, month, year }
    : null;
}
