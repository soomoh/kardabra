import { describe, expect, test } from 'vitest';
import { transactionKind } from '../../src/lib/kind';
import { hasPaymentKeyword } from '../../src/lib/spend';

describe('transactionKind', () => {
  test.each([
    // [payee, amount, expected]
    ['COOL COFFEE BANGALORE', -508.34, 'purchase'],
    ['ACME AGENCIES', 120, 'refund'],
    ['ACME AGENCIES', 0, 'purchase'],
    ['10% Swiggy Cashback (Ref# ST574325291891941)', 788.7, 'cashback'],
    ['CASH BACK CREDIT', 50, 'cashback'],
    ['CASHBACK ON EMI', 150, 'cashback'],
    ['FUEL SURCHARGES', -40, 'fee'],
    // A fee and its reversal are both fees: the sign says which way
    ['PETRO SURCHARGE WAIVER', 34.14, 'fee'],
    ['FUEL SURCHARGE', -34.14, 'fee'],
    ['LATE PAYMENT FEE', -700, 'fee'],
    ['ANNUAL FEE', -499, 'fee'],
    ['IGST-VPS2526123456789-RATE 18.0 -27', -126, 'fee'],
    ['OVERLIMIT CHARGES', -500, 'fee'],
    ['FINANCE CHARGES', -1200, 'interest'],
    ['FIN CHGS', -1200, 'interest'],
    ['INTEREST REVERSAL', 1200, 'interest'],
    ['CONSOLIDATED FCY MARKUP FEE', -87.5, 'forex-markup'],
    ['GST ON FOREX MARKUP', -15.75, 'forex-markup'],
    ['DCC MARKUP FEE', -20, 'forex-markup'],
    // Every part of an instalment plan stays an EMI line
    ['EMI 3/12 AMAZON PAY INDIA', -2500, 'emi'],
    ['EMI INTEREST', -310, 'emi'],
    ['GST ON EMI PROCESSING FEE', -36, 'emi'],
    // Words that only contain a keyword are not that keyword
    ['PINTEREST', -100, 'purchase'],
    ['SUPERCHARGED GYM', -1500, 'purchase'],
    ['FEEDBACK LABS', -200, 'purchase'],
  ])('%s (%d) → %s', (payee, amount, expected) => {
    expect(transactionKind(payee, amount, false)).toBe(expected);
  });

  test('the payment verdict comes from the caller and wins', () => {
    // An unlabelled payment that detectPayment found by amount
    expect(transactionKind('TELE TRANSFER CREDIT', 55463, true)).toBe(
      'payment',
    );
    expect(transactionKind('TELE TRANSFER CREDIT', 55463, false)).toBe(
      'refund',
    );
  });
});

// Payment wording seen on Indian card statements (CardQL's sample lines,
// checked 2026-10-30), against detectPayment's keyword rung.
describe('payment wording', () => {
  test.each([
    'AUTOPAY THANK YOU',
    'BBPS PAYMENT RECEIVED',
    'BBPS Payment received',
    'PAYMENT RECEIVED 12345678901234567890ABC',
    'PAYMENT THANK YOU - NETBANKING',
  ])('%s is a payment', (payee) => {
    expect(hasPaymentKeyword(payee)).toBe(true);
  });

  test.each([
    'LATE PAYMENT FEE',
    'AMAZON PAY INDIA PRIVA',
    'PAYTM*SWIGGY',
    'AIRTEL PAYMENTS BANK REFUND',
  ])('%s is not', (payee) => {
    expect(hasPaymentKeyword(payee)).toBe(false);
  });
});
