/**
 * Which bank issued a statement, from its own words: the header block above
 * the transaction table, where issuers print their name. Never the
 * transaction rows — a payment line on one bank's card routinely names
 * another ("PAYMENT HDFC NETBANKING" on an SBI card). An answer only when
 * exactly one issuer is named there; two names is a guess, not a fact.
 *
 * Data, not code: a new issuer is one line. India first, plus the big
 * international card issuers.
 */
import { cleanText } from './cells';

const ISSUERS: { name: string; pattern: RegExp }[] = [
  { name: 'HDFC Bank', pattern: /\bhdfc\b/i },
  { name: 'ICICI Bank', pattern: /\bicici\b/i },
  { name: 'Axis Bank', pattern: /\baxis\s+bank\b/i },
  {
    name: 'SBI Card',
    pattern: /\bsbi\s*cards?\b|\bstate\s+bank\s+of\s+india\b/i,
  },
  { name: 'Kotak Mahindra Bank', pattern: /\bkotak\b/i },
  { name: 'IndusInd Bank', pattern: /\bindusind\b/i },
  { name: 'Yes Bank', pattern: /\byes\s+bank\b/i },
  { name: 'IDFC FIRST Bank', pattern: /\bidfc\b/i },
  { name: 'RBL Bank', pattern: /\brbl\s+bank\b/i },
  { name: 'AU Small Finance Bank', pattern: /\bau\s+small\s+finance\b/i },
  { name: 'Federal Bank', pattern: /\bfederal\s+bank\b/i },
  { name: 'South Indian Bank', pattern: /\bsouth\s+indian\s+bank\b/i },
  { name: 'Indian Bank', pattern: /(?<!south\s)\bindian\s+bank\b/i },
  { name: 'Bank of Baroda', pattern: /\bbank\s+of\s+baroda\b|\bbob\s*card\b/i },
  { name: 'Canara Bank', pattern: /\bcanara\s+bank\b/i },
  { name: 'Punjab National Bank', pattern: /\bpunjab\s+national\s+bank\b/i },
  { name: 'Union Bank of India', pattern: /\bunion\s+bank\s+of\s+india\b/i },
  { name: 'OneCard', pattern: /\bonecard\b/i },
  { name: 'HSBC', pattern: /\bhsbc\b/i },
  { name: 'Standard Chartered', pattern: /\bstandard\s+chartered\b/i },
  { name: 'American Express', pattern: /\bamerican\s+express\b/i },
  { name: 'Citibank', pattern: /\bciti\s*bank\b/i },
  { name: 'Barclays', pattern: /\bbarclays\b/i },
  { name: 'Chase', pattern: /\bjpmorgan\s+chase\b|\bchase\s+card\b/i },
  { name: 'Capital One', pattern: /\bcapital\s+one\b/i },
];

/** The issuer named in the rows above the table (`headerAt`), or undefined
 * when none — or more than one — is named. */
export function issuerFromRows(
  rows: unknown[][],
  headerAt: number,
): string | undefined {
  const text = rows
    .slice(0, headerAt)
    .map((row) => row.map(cleanText).join(' '))
    .join('\n');
  const named = ISSUERS.filter(({ pattern }) => pattern.test(text));
  return named.length === 1 ? named[0].name : undefined;
}
