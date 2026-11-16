/**
 * Seeded generator of synthetic card-statement lines, each with the answer
 * Kardabra should give for it: the clean merchant name and the kind.
 *
 * Shapes are the ones real Indian card statements use (name + glued or
 * spaced city, "Name Limited,City", gateway prefixes, UPI prefixes,
 * reference tails); every name, reference and amount is made up or a public
 * brand. The expected merchant for a brand line is written here by hand,
 * not read from src/lib/merchantBrands.ts, so the tests check the table
 * rather than repeat it. Same seed → same lines, so a failure reproduces.
 *
 * Brand idea after the MIT-licensed Sumeetgpt synthetic generator (see
 * THIRD_PARTY_NOTICES.md); the shapes and code are Kardabra's own.
 */

import type { TransactionKind } from '../../src/lib/kind';

export interface StatementLine {
  raw: string;
  /** Money out negative, money in positive (parser/types.ts). */
  amount: number;
  merchant: string;
  kind: TransactionKind;
}

/** Mulberry32: tiny, seedable, good enough for test data. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [name as the bank prints it, merchant Kardabra should show]. Company
 * names are the ones banks print for the brand. */
const BRAND_NAMES: [string, string][] = [
  ['SWIGGY', 'Swiggy'],
  ['BUNDL TECHNOLOGIES PVT', 'Swiggy'],
  ['SWIGGY INSTAMART', 'Instamart'],
  ['Zomato Limited', 'Zomato'],
  ['JUBILANT FOODWORKS LTD', "Domino's"],
  ["DOMINO'S PIZZA", "Domino's"],
  ['UBER EATS', 'Uber Eats'],
  ['UBER INDIA SYSTEMS', 'Uber'],
  ['ANI TECHNOLOGIES PVT LT', 'Ola'],
  ['AVENUE SUPERMARTS LTD', 'DMart'],
  ['JIOMART', 'JioMart'],
  ['RELIANCE JIO INFOCOMM', 'Jio'],
  ['AMAZON PAY INDIA PRIVA', 'Amazon'],
  ['AMAZON PRIME MEMBERSHIP', 'Amazon Prime'],
  ['FLIPKART INTERNET', 'Flipkart'],
  ['INDITEX TRENT RETAIL', 'Zara'],
  ['H&M HENNES MAURITZ', 'H&M'],
  ['INTERGLOBE AVIATION', 'IndiGo'],
  ['IRCTC WEB', 'IRCTC'],
  ['MAKEMYTRIP INDIA PVT', 'MakeMyTrip'],
  ['BOOKMYSHOW', 'BookMyShow'],
  ['PVR LIMITED', 'PVR'],
  ['NETFLIX.COM', 'Netflix'],
  ['SPOTIFY INDIA', 'Spotify'],
  ['APPLE.COM/BILL', 'Apple'],
  ['TATA 1MG HEALTHCARE', 'Tata 1mg'],
  ['APOLLO PHARMACY', 'Apollo'],
  ['THINK AND LEARN PVT', "BYJU'S"],
  ['LIC HOUSING FINANCE', 'LIC Housing Finance'],
  ['LIC OF INDIA PREMIUM', 'LIC'],
  ['BHARAT PETROLEUM CORP', 'Bharat Petroleum'],
  ['IKEA Limited', 'IKEA'],
];

/** [raw name, cleaned name] for merchants no table knows: the cleaner must
 * keep their own words, initials, `&` and apostrophes. */
const LOCAL_NAMES: [string, string][] = [
  ['COOL COFFEE', 'COOL COFFEE'],
  ['ACME AGENCIES', 'ACME AGENCIES'],
  ['DOG PLACE', 'DOG PLACE'],
  ['SRI LAKSHMI STORES', 'SRI LAKSHMI STORES'],
  ["RAJU'S TIFFIN CENTRE", "RAJU'S TIFFIN CENTRE"],
  ['A&B HARDWARE', 'A&B HARDWARE'],
  ['K.R. MEDICALS', 'K.R. MEDICALS'],
  ['Green Leaf Organics', 'Green Leaf Organics'],
];

const CITIES = [
  'BANGALORE',
  'BENGALURU',
  'MUMBAI',
  'NEW DELHI',
  'GURGAON',
  'PUNE',
  'HYDERABAD',
  'CHENNAI',
];
const GATEWAYS = ['PAYTM*', 'RAZ*', 'PYU*', 'PAYU*', 'CCA*'];

type Pick = <T>(xs: readonly T[]) => T;

function digits(random: () => number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i += 1) s += Math.floor(random() * 10).toString();
  return s;
}

function amount(random: () => number, max: number): number {
  return Math.round((10 + random() * max) * 100) / 100;
}

/** A purchase line in one of the bank layouts, e.g. HDFC pads the name to 22
 * characters and glues the city on; Axis puts the city after a comma. */
function purchaseText(random: () => number, pick: Pick, name: string): string {
  const city = pick(CITIES);
  const layouts: (() => string)[] = [
    () => `${name} ${city}`,
    () =>
      `${name.slice(0, 22).trimEnd()}${city.length >= 8 ? city : ' ' + city}`,
    () => `${name},${city.charAt(0)}${city.slice(1).toLowerCase()}`,
    () => `${pick(GATEWAYS)}${name} ${city} IN`,
    () => `UPI-${digits(random, 12)}-${name}`,
    () => `${name} ${city} IND (Ref# ST${digits(random, 20)})`,
    () => `POS ${name} ${city}`,
  ];
  return pick(layouts)();
}

/** Non-purchase lines: [raw, sign, merchant, kind]. Payment lines carry the
 * statement's own payment wording, so detectPayment labels them. */
function specialLine(
  random: () => number,
  pick: Pick,
): Omit<StatementLine, 'amount'> & { sign: 1 | -1 } {
  const ref = digits(random, 12);
  const options: (() => Omit<StatementLine, 'amount'> & { sign: 1 | -1 })[] = [
    () => ({
      raw: 'BBPS Payment Received',
      sign: 1,
      merchant: 'BBPS Payment Received',
      kind: 'payment',
    }),
    () => ({
      raw: `BBPS Payment Received - DP0${ref}JICeam`,
      sign: 1,
      merchant: 'BBPS Payment Received',
      kind: 'payment',
    }),
    () => ({
      raw: 'AUTOPAY THANK YOU',
      sign: 1,
      merchant: 'AUTOPAY THANK YOU',
      kind: 'payment',
    }),
    () => ({
      raw: `PAYMENT RECEIVED ${ref}ABCDEFGHIJK`,
      sign: 1,
      merchant: 'PAYMENT RECEIVED',
      kind: 'payment',
    }),
    () => ({
      raw: `10% Swiggy Cashback (Ref# ST${ref})`,
      sign: 1,
      merchant: 'Swiggy',
      kind: 'cashback',
    }),
    () => ({
      raw: 'CASHBACK CREDIT',
      sign: 1,
      merchant: 'CASHBACK CREDIT',
      kind: 'cashback',
    }),
    () => ({
      raw: 'PETRO SURCHARGE WAIVER',
      sign: 1,
      merchant: 'PETRO SURCHARGE WAIVER',
      kind: 'fee',
    }),
    () => ({
      raw: 'FUEL SURCHARGE',
      sign: -1,
      merchant: 'FUEL SURCHARGE',
      kind: 'fee',
    }),
    () => ({
      raw: 'LATE PAYMENT FEE',
      sign: -1,
      merchant: 'LATE PAYMENT FEE',
      kind: 'fee',
    }),
    () => ({
      raw: 'ANNUAL FEE',
      sign: -1,
      merchant: 'ANNUAL FEE',
      kind: 'fee',
    }),
    () => ({
      raw: `IGST-VPS2526${ref}-RATE 18.0 -27 (Ref# ST${ref})`,
      sign: -1,
      merchant: 'IGST RATE 18.0 -27',
      kind: 'fee',
    }),
    () => ({
      raw: 'FINANCE CHARGES',
      sign: -1,
      merchant: 'FINANCE CHARGES',
      kind: 'interest',
    }),
    () => ({
      raw: 'INTEREST ON PURCHASES',
      sign: -1,
      merchant: 'INTEREST ON PURCHASES',
      kind: 'interest',
    }),
    () => ({
      raw: 'CONSOLIDATED FCY MARKUP FEE',
      sign: -1,
      merchant: 'CONSOLIDATED FCY MARKUP FEE',
      kind: 'forex-markup',
    }),
    () => ({
      raw: 'EMI 3/12 AMAZON PAY INDIA PRIVA',
      sign: -1,
      merchant: 'Amazon',
      kind: 'emi',
    }),
    () => ({
      raw: 'EMI INTEREST 3/12',
      sign: -1,
      merchant: 'EMI INTEREST 3/12',
      kind: 'emi',
    }),
  ];
  return pick(options)();
}

/** `count` lines from `seed`: about 70% purchases (brand and local
 * merchants), 10% refunds, 20% payments, fees and the rest. */
export function generateLines(seed: number, count: number): StatementLine[] {
  const random = rng(seed);
  const pick: Pick = (xs) => xs[Math.floor(random() * xs.length)];
  const lines: StatementLine[] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = random();
    if (roll < 0.8) {
      const [name, merchant] =
        random() < 0.6 ? pick(BRAND_NAMES) : pick(LOCAL_NAMES);
      const refund = roll >= 0.7;
      lines.push({
        raw: refund
          ? `REFUND ${name} ${pick(CITIES)}`
          : purchaseText(random, pick, name),
        amount: refund ? amount(random, 3000) : -amount(random, 8000),
        merchant:
          refund && !BRAND_NAMES.some(([n]) => n === name)
            ? `REFUND ${merchant}`
            : merchant,
        kind: refund ? 'refund' : 'purchase',
      });
    } else {
      const { sign, ...line } = specialLine(random, pick);
      lines.push({
        ...line,
        amount: sign * amount(random, sign > 0 ? 40000 : 2000),
      });
    }
  }
  return lines;
}
