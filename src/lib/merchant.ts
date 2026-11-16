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

/** The payee with known noise removed, original case kept. Never empty:
 * when stripping would leave nothing, the collapsed raw text is returned. */
export function stripPayee(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
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
