/**
 * Turns a raw statement payee into a merchant name a person recognises:
 * "PAYTM*BUNDL TECHNOLOGIES PVT BANGALORE IN" → "Swiggy",
 * "COOL COFFEE BANGALORE" → "COOL COFFEE".
 *
 * Deterministic and conservative: the same text always gives the same name,
 * and only known noise is removed (payment-gateway and UPI prefixes,
 * reference numbers, a trailing city or country). The merchant's own words
 * keep their spelling and case; nothing is guessed. A known brand, matched
 * by name or by the company name banks print, replaces the whole text.
 *
 * The raw payee is never replaced anywhere: this is a derived label, used for
 * display and as its own export column, so a better table never breaks rules
 * someone wrote against the raw text.
 */

import { BRANDS } from './merchantBrands';

/** Indian and common foreign cities banks append after the merchant. Names
 * that are often a merchant's own word ("GOA") are left out; a rare shop
 * named after its city ("HOTEL SURAT") loses that word — accepted, since
 * the city suffix is on nearly every line. */
const CITIES = [
  'BANGALORE',
  'BENGALURU',
  'MUMBAI',
  'NAVI MUMBAI',
  'NEW DELHI',
  'DELHI',
  'GURGAON',
  'GURGOAN', // as some merchants spell it
  'GURUGRAM',
  'NOIDA',
  'HYDERABAD',
  'SECUNDERABAD',
  'CHENNAI',
  'PUNE',
  'KOLKATA',
  'AHMEDABAD',
  'JAIPUR',
  'LUCKNOW',
  'KOCHI',
  'COCHIN',
  'ERNAKULAM',
  'CHANDIGARH',
  'INDORE',
  'BHOPAL',
  'SURAT',
  'NAGPUR',
  'THANE',
  'VADODARA',
  'COIMBATORE',
  'MYSORE',
  'MYSURU',
  'MANGALORE',
  'MANGALURU',
  'TRIVANDRUM',
  'THIRUVANANTHAPURAM',
  'VISAKHAPATNAM',
  'BHUBANESWAR',
  'PATNA',
  'PANAJI',
  'SINGAPORE',
  'LONDON',
  'DUBLIN',
  'AMSTERDAM',
  'LUXEMBOURG',
  'SAN FRANCISCO',
  'MOUNTAIN VIEW',
  'CUPERTINO',
  'SEATTLE',
  'NEW YORK',
  'DUBAI',
  // Longest first, so "NAVI MUMBAI" is removed whole rather than leaving "NAVI".
].sort((a, b) => b.length - a.length);

// A city stuck to the end of a cut-off name ("PRIVATE LIBANGALORE": HDFC pads
// the name to a fixed width) is only recognised for long city names; a short
// one ("PUNE", "THANE") would eat the end of ordinary words.
const MIN_GLUED_CITY = 8;

// Country codes after the city ("BANGALORE IN"), removed only when a city
// comes before them ("CHECK IN" keeps its IN). Deliberately short: a wider
// ISO list would strip real words ("LI" is a cut-off "LIMITED" as often as
// Liechtenstein), and no "INDIA": it ends "AIR INDIA" and "LIC OF INDIA".
const COUNTRIES = [
  'IN',
  'IND',
  'US',
  'USA',
  'GB',
  'GBR',
  'SG',
  'SGP',
  'IE',
  'IRL',
  'AE',
  'ARE',
];

/** Leading channel word that says how the card was used, not who was paid.
 * Only POS: "ECOM" and "NFC" also start real names (Ecom Express). */
const CHANNEL_PREFIX = /^POS[\s-]+/i;
/** "UPI-123456789012-", "UPI/P2M/123456789012/". */
const UPI_PREFIX = /^UPI[-/](?:P2[AM][-/])?\d*[-/]?/i;
/** Payment gateways and aggregators printed before a star ("PAYTM*SWIGGY",
 * "RAZ*ACME"). Only these are removed: before a star there is just as often
 * the merchant itself ("UBER *TRIP", "OPENAI *CHATGPT"), so any other star
 * becomes a space. */
const GATEWAY_PREFIX =
  /^(?:PAYTM|PAYU|PYU|RAZ|RZP|RSP|CCA|CCAVENUE|BD|BDSI|BILLDESK|IND|PP|PAYPAL|SQ|EBS|ATOM|JUSPAY|PHONEPE|PAY) ?\*\s*/i;
/** "(Ref# ST2526…)" or a bare "Ref# ST2526…" tail. The bracket's length is
 * capped so text full of unclosed "(Ref#" can't make the match quadratic. */
const REF_TAIL = /\(\s*REF\b[^)]{0,60}\)|\bREF\s*(?:NO\.?|#|:)\s*\S*/gi;
/** Placeholder for a removed token; never appears in statement text. */
const CUT = '\uE000';

/** Is this run of letters and digits a reference number rather than a word?
 * Eight or more characters with at least six digits: "DP015290171647JICeam",
 * "ST252661234560010230917". Keeps "ZEE5", "7ELEVEN", "FIRSTCRY2024",
 * "NH1234". */
function isReference(token: string): boolean {
  if (token.length < 8) return false;
  let digits = 0;
  for (const ch of token) if (ch >= '0' && ch <= '9') digits += 1;
  return digits >= 6;
}

/** "BANGALORE" or "SAN FRANCISCO": a known place, after any comma. */
function isPlace(upper: string): boolean {
  return CITIES.includes(upper) || COUNTRIES.includes(upper);
}

function stripTrailingWord(
  text: string,
  words: string[],
  glued: boolean,
): string {
  const upper = text.toUpperCase();
  // Slicing `text` by lengths measured on `upper` is only safe when
  // upper-casing kept the length ("ß" → "SS" does not).
  if (upper.length !== text.length) return text;
  for (const word of words) {
    if (upper.endsWith(' ' + word)) return text.slice(0, -word.length - 1);
    if (
      glued &&
      word.length >= MIN_GLUED_CITY &&
      upper.endsWith(word) &&
      upper.length - word.length >= 3
    ) {
      return text.slice(0, -word.length);
    }
  }
  return text;
}

/** The bank's offer printed on an eligible purchase ("AMAZON (Pay in
 * EMIs)"): it says the purchase *could* be converted, not that it was. Not
 * part of the merchant's name, and must not make the line an EMI line. */
const EMI_OFFER = /\s*\(?\s*\bPAY IN EMIS?\b\s*\)?/gi;

/** The payee without the bank's "(Pay in EMIs)" offer marker. */
export function withoutOfferMarker(payee: string): string {
  return payee.replace(EMI_OFFER, '');
}

/** A foreign-currency amount after the name ("NETFLIX 99 USD", "AWS USD
 * 12.50"): the same merchant prints a different one each month. */
const FOREIGN_AMOUNT_TAIL =
  /\s+(?:\d[\d,]*(?:\.\d+)?\s*(?:USD|EUR|GBP|SGD|AED|AUD|CAD|JPY|CHF|HKD|THB|MYR)|(?:USD|EUR|GBP|SGD|AED|AUD|CAD|JPY|CHF|HKD|THB|MYR)\s*\d[\d,]*(?:\.\d+)?)$/i;

/** "WWWBIGBASKETCOM", "WWW.BIGBASKET.COMGURGOAN": a web address printed as
 * the name, sometimes with the city glued on. The address's name part is
 * kept and a glued city split off (so the city rule removes it); anything
 * else after the domain ending means it wasn't an address, and the word is
 * left alone. */
const DOMAIN_WORD = new RegExp(
  `^WWW\\.?([A-Z0-9-]{3,}?)\\.?(?:COM|CO\\.?IN|IN|NET|ORG)(${CITIES.join('|').replace(/ /g, '')})?$`,
);

function unwrapDomain(word: string): string {
  const match = DOMAIN_WORD.exec(word.toUpperCase());
  if (match === null || word.length !== word.toUpperCase().length) return word;
  const name = word.slice(3).replace(/^\./, '').slice(0, match[1].length);
  return match[2] ? `${name} ${match[2]}` : name;
}

const GLUED_TAIL_WORDS = new Set([
  ...CITIES.map((city) => city.replace(/ /g, '')),
  'LIMITED',
  'LTD',
  'PVT',
  'PRIVATE',
  'LLP',
  'INC',
  'LLC',
]);

/** "TataPaymentsLimitedMumbai" → "TataPayments Limited Mumbai": a city or
 * legal word glued in title case onto the end of a name is split off, so
 * the city rule can remove it and the grouping key can drop it. Only those
 * known words: a brand's own capitals ("MakeMyTrip", "PhonePe", "eBay")
 * stay as they are, and the brand table still matches them. */
function splitGluedTail(word: string): string {
  let head = word;
  const tail: string[] = [];
  for (;;) {
    const match = /^(.*[a-z])([A-Z][a-z]+)$/.exec(head);
    if (match === null || !GLUED_TAIL_WORDS.has(match[2].toUpperCase())) break;
    tail.unshift(match[2]);
    head = match[1];
  }
  return [head, ...tail].join(' ');
}

/** The payee with known noise removed, original case kept. Never empty:
 * when stripping would leave nothing, the collapsed raw text is returned. */
export function stripPayee(raw: string): string {
  const collapsed = withoutOfferMarker(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(FOREIGN_AMOUNT_TAIL, '')
    .split(' ')
    .map((word) => splitGluedTail(unwrapDomain(word)))
    .join(' ');
  // Prefixes first: the UPI prefix holds a reference number, and once that
  // is cut out the prefix no longer looks like one.
  let text = collapsed
    .replace(UPI_PREFIX, '')
    .replace(CHANNEL_PREFIX, '')
    .replace(GATEWAY_PREFIX, '')
    .replace(/\s*\*\s*/g, ' ')
    .replace(REF_TAIL, CUT)
    .replace(/[A-Za-z0-9]{6,}/g, (token) => (isReference(token) ? CUT : token))
    // A removed token takes its separators with it ("IGST-…-RATE" → "IGST RATE").
    .replace(/[\s\-/#:]*\uE000[\s\-/#:]*/g, ' ')
    .trim();

  // ",Bangalore" / ", NEW DELHI": a known place after the last comma.
  // Anything else stays ("ACME, INC", "SMITH, JOHN").
  const comma = text.lastIndexOf(',');
  if (
    comma > 0 &&
    isPlace(
      text
        .slice(comma + 1)
        .trim()
        .toUpperCase(),
    )
  ) {
    text = text.slice(0, comma);
  }
  const withoutCountry = stripTrailingWord(text, COUNTRIES, false);
  const withoutCity = stripTrailingWord(withoutCountry, CITIES, true);
  // A country code goes only together with the city before it.
  if (withoutCity !== withoutCountry) text = withoutCity;
  else text = stripTrailingWord(text, CITIES, true);

  text = text.replace(/^[\s\-–,:.]+|[\s\-–,:.]+$/g, '').replace(/\s+/g, ' ');
  return text === '' ? collapsed : text;
}

/** Legal-form words that one statement prints and another drops. */
const LEGAL_WORDS = /\b(?:PRIVATE|PVT|LIMITED|LTD|LLP|INC|LLC)\b\.?/g;

/**
 * The key two spellings of one merchant share: upper case, legal-form words
 * dropped, and nothing but letters and digits (any script), so
 * "TATAPAYMENTS", "TATA PAYMENTS LTD" and "TataPaymentsLimited" group
 * together. A legal word glued on in capitals ("…PAYMENTSLIMITED") is not
 * cut: it can't be told from a word's end ("UNLIMITED"). For grouping
 * only; the shown name stays `cleanMerchant`'s.
 */
export function merchantKey(name: string): string {
  const upper = name.toUpperCase();
  const key = upper.replace(LEGAL_WORDS, ' ').replace(/[^\p{L}\p{N}]/gu, '');
  return key === '' ? upper.replace(/[^\p{L}\p{N}]/gu, '') || upper : key;
}

/** The merchant name for a raw payee: a known brand's display name when one
 * matches, otherwise `stripPayee`'s cleaned text. */
export function cleanMerchant(raw: string): string {
  const stripped = stripPayee(raw);
  const upper = stripped.toUpperCase();
  for (const brand of BRANDS) {
    if (brand.match.test(upper)) return brand.name;
  }
  return stripped;
}
