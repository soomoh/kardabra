import { describe, expect, test } from 'vitest';
import { cleanMerchant, merchantKey, stripPayee } from '../../src/lib/merchant';
import { BRANDS } from '../../src/lib/merchantBrands';
import { hasPaymentKeyword } from '../../src/lib/spend';
import { transactionKind } from '../../src/lib/kind';
import { generateLines } from '../fixtures/statementLines';

describe('stripPayee: the shapes banks print', () => {
  test.each([
    // HDFC: name, then city; a full-width name gets the city glued on
    ['COOL COFFEE BANGALORE', 'COOL COFFEE'],
    ['COMPANY CO BENGALURU', 'COMPANY CO'],
    ['JBS CORP PRIVATE LIBANGALORE', 'JBS CORP PRIVATE LI'],
    // Axis / IDFC: city after a comma
    ['Zomato Limited,Bangalore', 'Zomato Limited'],
    ['DISTRICT MOVIE TICKE,NEW DELHI', 'DISTRICT MOVIE TICKE'],
    // ICICI / SBI: gateway prefix, city and country
    ['PAYTM*COOL COFFEE BANGALORE IN', 'COOL COFFEE'],
    ['PYU *ACME AGENCIES MUMBAI IND', 'ACME AGENCIES'],
    ['NAVI MUMBAI STORES NAVI MUMBAI', 'NAVI MUMBAI STORES'],
    // UPI and channel prefixes
    ['UPI-123456789012-DOG PLACE', 'DOG PLACE'],
    ['UPI/P2M/123456789012/DOG PLACE', 'DOG PLACE'],
    ['POS ACME AGENCIES PUNE', 'ACME AGENCIES'],
    // Reference tails
    [
      'TELE TRANSFER CREDIT (Ref# ST252661234560010230917)',
      'TELE TRANSFER CREDIT',
    ],
    ['BBPS Payment Received - DP015290171647JICeam', 'BBPS Payment Received'],
    ['PAYMENT RECEIVED REF NO. 000123456789', 'PAYMENT RECEIVED'],
    ['IGST-VPS2526123456789-RATE 18.0 -27 (Ref# ST2526)', 'IGST RATE 18.0 -27'],
  ])('%s → %s', (raw, expected) => {
    expect(stripPayee(raw)).toBe(expected);
  });

  test.each([
    // The merchant's own words survive: initials, &, apostrophes, digits
    ["RAJU'S TIFFIN CENTRE", "RAJU'S TIFFIN CENTRE"],
    ['A&B HARDWARE', 'A&B HARDWARE'],
    ['K.R. MEDICALS', 'K.R. MEDICALS'],
    ['ZEE5 SUBSCRIPTION', 'ZEE5 SUBSCRIPTION'],
    ['7ELEVEN', '7ELEVEN'],
    // A word that ends in a short city name is not a city
    ['NEPTUNE', 'NEPTUNE'],
    ['AIR INDIA', 'AIR INDIA'],
    // Words that start like "REF" are not reference tails
    ['REFUND COOL COFFEE', 'REFUND COOL COFFEE'],
    // Digits in a name are not a reference number
    ['FIRSTCRY2024 PUNE', 'FIRSTCRY2024'],
    ['NH1234 TOLL', 'NH1234 TOLL'],
    // Only a known place goes after a comma
    ['ACME, INC', 'ACME, INC'],
    ['SMITH, JOHN', 'SMITH, JOHN'],
    // A country code goes only with the city before it
    ['CHECK IN', 'CHECK IN'],
    ['REGUS US', 'REGUS US'],
    // "ECOM" and "NFC" start real names; only POS is a channel word
    ['ECOM EXPRESS PVT LTD', 'ECOM EXPRESS PVT LTD'],
    ['NFC TAG SHOP', 'NFC TAG SHOP'],
    ['CAFE GOA', 'CAFE GOA'],
    // A star after anything but a known gateway is a separator
    ['ACME *ORDER 4821', 'ACME ORDER 4821'],
    ['Q*ACME', 'Q ACME'],
  ])('keeps %s', (raw, expected) => {
    expect(stripPayee(raw)).toBe(expected);
  });
});

describe('stripPayee: malformed input', () => {
  test.each([
    ['', ''],
    ['   ', ''],
    ['\t\n', ''],
    // Nothing but noise: the raw text comes back rather than an empty name
    ['(Ref# ST252661234560010230917)', '(Ref# ST252661234560010230917)'],
    ['BANGALORE', 'BANGALORE'],
    ['PAYTM*', 'PAYTM*'],
  ])('%j → %j', (raw, expected) => {
    expect(stripPayee(raw)).toBe(expected);
  });

  test('a long hostile payee is cleaned quickly', () => {
    const inputs = [
      'A'.repeat(100_000),
      '1a'.repeat(50_000),
      'FCY '.repeat(25_000),
      '(Ref# '.repeat(20_000),
      ', '.repeat(50_000) + 'X',
    ];
    const start = performance.now();
    for (const raw of inputs) {
      cleanMerchant(raw);
      transactionKind(raw, -1, false);
    }
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('cleanMerchant: brands', () => {
  test.each([
    ['BUNDL TECHNOLOGIES PVT BANGALORE', 'Swiggy'],
    ['PAYTM*SWIGGY INSTAMART BANGALORE IN', 'Instamart'],
    ['UBER EATS INDIA', 'Uber Eats'],
    ['UBER INDIA SYSTEMS BANGALORE', 'Uber'],
    ['JIOMART MUMBAI', 'JioMart'],
    ['RELIANCE JIO INFOCOMM', 'Jio'],
    ['LIC HOUSING FINANCE MUMBAI', 'LIC Housing Finance'],
    ['LIC OF INDIA PREMIUM', 'LIC'],
    ['AMAZON PRIME MEMBERSHIP', 'Amazon Prime'],
    ['AMAZON PAY INDIA PRIVA BANGALORE', 'Amazon'],
    ['JUBILANT FOODWORKS LTD NOIDA', "Domino's"],
    ['INDITEX TRENT RETAIL', 'Zara'],
    ['10% Swiggy Cashback (Ref# ST574325291891941)', 'Swiggy'],
    ['IKEA Limited,Bangalore', 'IKEA'],
    // A web address as the name, city glued on or not
    ['WWWBIGBASKETCOM', 'BigBasket'],
    ['WWWBIGBASKETCOMGURGOAN', 'BigBasket'],
    ['WWW.BIGBASKET.COM GURGAON', 'BigBasket'],
    ['WWWCOMMONFLOORCOM', 'COMMONFLOOR'],
    // A foreign amount after the name
    ['NETFLIX.COM 99 USD', 'Netflix'],
    ['AWS EMEA USD 12.50', 'AWS EMEA'],
    // A city or legal word glued on in title case; a brand's own capitals stay
    ['TataPaymentsLimitedMumbai', 'TataPayments Limited'],
    ['PhonePe', 'PhonePe'],
    ['MakeMyTrip', 'MakeMyTrip'],
    ['MakeMyTripLimited', 'MakeMyTrip'],
    ['BookMyShow', 'BookMyShow'],
    ['eBayInc', 'eBay Inc'],
    // The bank's EMI offer marker is not part of the name
    ['COOL STORE (Pay in EMIs)', 'COOL STORE'],
    ['COOL STORE Pay in EMI', 'COOL STORE'],
    ['EMI WWWBIGBASKETCOM', 'BigBasket'],
    ['EMI UPI-COOL STORE', 'COOL STORE'],
    ['EMI 3/12 COOL STORE', 'EMI 3/12 COOL STORE'],
    // Too short to be a web address
    ['WWWINCOM', 'WWWINCOM'],
  ])('%s → %s', (raw, expected) => {
    expect(cleanMerchant(raw)).toBe(expected);
  });

  test('merchantKey: spellings of one merchant meet, others stay apart', () => {
    const key = (raw: string) => merchantKey(cleanMerchant(raw));
    expect(
      new Set(
        [
          'TataPaymentsLimitedMumbai',
          'TATAPAYMENTS',
          'TataPaymentsLimited',
          'TATA PAYMENTS PVT LTD',
        ].map(key),
      ),
    ).toEqual(new Set(['TATAPAYMENTS']));
    expect(key('TATANEUBROADBAND')).not.toBe(key('TATAPAYMENTS'));
    expect(merchantKey('LIMITED')).toBe('LIMITED'); // never empty
    // A word's own ending is not a legal word
    expect(merchantKey('UNLIMITED')).toBe('UNLIMITED');
    expect(merchantKey('CAFÉ X')).not.toBe(merchantKey('CAF X'));
  });

  test.each([
    // The merchant before a star is the brand, not a gateway
    ['UBER *EATS', 'Uber Eats'],
    ['UBER *TRIP HELP.UBER.COM', 'Uber'],
    ['OPENAI *CHATGPT SUBSCR SAN FRANCISCO US', 'OpenAI'],
    ['ZOMATO*ORDER', 'Zomato'],
    ['NETFLIX*SUB', 'Netflix'],
    ['AIRBNB *HMABC123', 'Airbnb'],
    ['MCDONALDS NOIDA', "McDonald's"],
    ['JIOHOTSTAR', 'Hotstar'],
  ])('brand before a star or with a suffix: %s → %s', (raw, expected) => {
    expect(cleanMerchant(raw)).toBe(expected);
  });

  test.each([
    // \b keeps short brand names from matching inside other words
    ['BOYOTA MOTORS', 'BOYOTA MOTORS'],
    ['PUBLIC STORES', 'PUBLIC STORES'],
    // Brand names match whole words only
    ['INDIAN OILSEEDS TRADERS', 'INDIAN OILSEEDS TRADERS'],
    ['APOLLONIA RESTAURANT', 'APOLLONIA RESTAURANT'],
    ['AMAZONIA', 'AMAZONIA'],
    ['PINTEREST', 'PINTEREST'],
  ])('%s is no brand', (raw, expected) => {
    expect(cleanMerchant(raw)).toBe(expected);
  });

  test("no brand's own name is claimed by a different brand", () => {
    const names = new Set(BRANDS.map((brand) => brand.name));
    for (const brand of BRANDS) {
      const raw = brand.name.toUpperCase();
      const result = cleanMerchant(raw);
      // Some brands match only on the company name ("MORE RETAIL"), so the
      // bare name may come back unchanged; what must never happen is
      // another brand's name.
      if (names.has(result)) expect(result, raw).toBe(brand.name);
    }
  });
});

describe('generated statement lines', () => {
  const seeds = [1, 42, 2026, 90210];

  test('the same seed gives the same lines', () => {
    expect(generateLines(7, 50)).toEqual(generateLines(7, 50));
  });

  test.each(seeds)('seed %i: merchant, kind and payment wording', (seed) => {
    for (const line of generateLines(seed, 400)) {
      const context = `raw: ${line.raw}`;
      expect(cleanMerchant(line.raw), context).toBe(line.merchant);
      // The statement's own payment wording is detectPayment's first signal:
      // it must find every payment line and nothing else.
      const isPayment = line.amount > 0 && hasPaymentKeyword(line.raw);
      expect(isPayment, context).toBe(line.kind === 'payment');
      expect(transactionKind(line.raw, line.amount, isPayment), context).toBe(
        line.kind,
      );
    }
  });
});
