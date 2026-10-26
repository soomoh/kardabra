/**
 * Which bank a statement file is from, by its file name alone — a locked
 * PDF can't be read until it is opened, and the bank decides which password
 * patterns to try first. Rules as data, after burnrate's detector
 * (github.com/pratik-devx/burnrate @ a6c9267, Apache-2.0; see
 * THIRD_PARTY_NOTICES.md). A wrong or missing answer only changes the order
 * passwords are tried in, never whether a file opens.
 */

import type { Bank } from './pdfPassword';

// Checked in order; first match wins.
const NAME_RULES: { bank: Bank; pattern: RegExp }[] = [
  { bank: 'hdfc', pattern: /hdfc/i },
  { bank: 'icici', pattern: /icici/i },
  // HDFC's download naming: "<4 digits><10 X><2 digits>_DD-MM-YYYY_<n>.pdf".
  { bank: 'hdfc', pattern: /^\d{4}X{10}\d{2}_\d{2}-\d{2}-\d{4}_\d+\.pdf$/i },
  // Axis names its download just "Credit Card Statement.pdf". Generic, but a
  // wrong guess only changes the order patterns are tried in.
  { bank: 'axis', pattern: /^credit card statement( ?\(\d+\))?\.pdf$/i },
  // ICICI's own download naming: "<masked card>_<id>_Retail_<product>_NORM.pdf".
  { bank: 'icici', pattern: /_Retail_[A-Za-z]+_NORM\.pdf$/i },
  { bank: 'axis', pattern: /axis/i },
  { bank: 'sbi', pattern: /sbi|state[ _-]?bank/i },
  { bank: 'federal', pattern: /federal|scapia/i },
  { bank: 'indian_bank', pattern: /(?<!south[ _-]?)indian[ _-]?bank/i },
  // SBI Card names its downloads "<10–16 digit reference>_<DDMMYYYY>.pdf".
  { bank: 'sbi', pattern: /^\d{10,16}_\d{8}\.pdf$/i },
];

// Issuer prefixes (first four digits) seen in masked card numbers that some
// banks put in the file name, e.g. "4386XXXXXXXX4219.pdf".
const BIN_PREFIXES: Record<string, Bank> = {
  ...Object.fromEntries(
    ['5522', '4386', '4567', '5241', '4543', '5254', '4213'].map((b) => [
      b,
      'hdfc' as const,
    ]),
  ),
  ...Object.fromEntries(
    ['4568', '5243', '4998', '5236', '4389', '4315', '5270', '4329'].map(
      (b) => [b, 'icici' as const],
    ),
  ),
  ...Object.fromEntries(
    ['4108', '4178', '5269', '4021', '4717'].map((b) => [b, 'axis' as const]),
  ),
};

/** How each bank is named to the user. */
export const BANK_NAMES: Record<Bank, string> = {
  hdfc: 'HDFC Bank',
  icici: 'ICICI Bank',
  axis: 'Axis Bank',
  sbi: 'SBI Card',
  federal: 'Federal Bank',
  indian_bank: 'Indian Bank',
};

export function bankFromFileName(fileName: string): Bank | null {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  for (const { bank, pattern } of NAME_RULES) {
    if (pattern.test(base)) return bank;
  }
  const bin = /(\d{4})[Xx*]+\d{2,4}/.exec(base)?.[1];
  return (bin && BIN_PREFIXES[bin]) || null;
}

/** The locked-files summary line: "68 statements from 5 banks", "1
 * statement from SBI Card", or just "3 statements" when any file's bank
 * can't be told from its name. */
export function statementsSummary(fileNames: string[]): string {
  const count = fileNames.length;
  const noun = count === 1 ? '1 statement' : `${count} statements`;
  const banks = fileNames.map(bankFromFileName);
  if (count === 0 || banks.includes(null)) return noun;
  const distinct = [...new Set(banks)] as Bank[];
  return distinct.length === 1
    ? `${noun} from ${BANK_NAMES[distinct[0]]}`
    : `${noun} from ${distinct.length} banks`;
}

/** The issuer a statement names in its own header (parser/issuer.ts),
 * unless its file name clearly points at a different bank — then neither
 * is trusted. Undefined when not sure. */
export function confirmedIssuer(statement: {
  issuer?: string;
  fileName: string;
}): string | undefined {
  if (statement.issuer === undefined) return undefined;
  const fromName = bankFromFileName(statement.fileName);
  return fromName === null || BANK_NAMES[fromName] === statement.issuer
    ? statement.issuer
    : undefined;
}
