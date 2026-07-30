import { describe, it, expect } from 'vitest';
import {
  classifyCharge,
  chargeTotals,
  annualFeeNet,
} from '../../src/lib/charges';

describe('classifyCharge', () => {
  it.each([
    ['FINANCE CHARGE FOR OCT', 'interest'],
    ['Interest levied on cash advance', 'interest'],
    ['LATE FEE CHARGED', 'late'],
    ['Late Payment Fee', 'late'],
    ['OVERLIMIT FEE', 'late'],
    ['Over Limit Charge', 'late'],
    ['ANNUAL FEE', 'annual-fee'],
    ['MEMBERSHIP FEE 2025', 'annual-fee'],
    ['CARD RENEWAL FEE', 'annual-fee'],
    ['JOINING FEE', 'annual-fee'],
  ] as const)('%s -> %s', (payee, category) => {
    expect(classifyCharge(payee)).toBe(category);
  });

  it.each([
    // Ordinary activity: never a charge.
    'COOL COFFEE BANGALORE',
    'BPPY CC PAYMENT BD0161',
    'DOG PLACE',
    // Transactional friction, deliberately untracked: per-purchase costs
    // of USING the card, not of owning it. The surcharge waiver still
    // nets into spend via lib/spend.ts.
    'PETRO SURCHARGE',
    'PETRO SURCHARGE WAIVER',
    'PROCESSING FEE - LOAN',
    'CASH ADVANCE FEE',
    'REWARD REDEMPTION FEE',
    'SMS CHARGE Q3',
    'IGST',
    'CGST ON FEE',
    'SGST ON FEE',
    'GST',
  ])('not a tracked charge: %s', (payee) => {
    expect(classifyCharge(payee)).toBeNull();
  });
});

describe('chargeTotals — sign-aware netting', () => {
  it('an annual-fee debit adds to its category', () => {
    const totals = chargeTotals([{ payee: 'ANNUAL FEE', amount: -500 }]);
    expect(totals['annual-fee']).toBe(500);
    expect(totals.interest).toBe(0);
    expect(totals.late).toBe(0);
  });

  it('a fee-reversal credit nets against the fee its debit added', () => {
    const totals = chargeTotals([
      { payee: 'ANNUAL FEE', amount: -500 },
      { payee: 'ANNUAL FEE REVERSAL', amount: 500 },
    ]);
    expect(totals['annual-fee']).toBe(0);
  });

  it('CATASTROPHIC-MODE PIN: a bill-payment credit must never appear in chargeTotals', () => {
    // The worst wrong answer for this feature: a routine ~22,000 rupee
    // bill payment misread as a "fee reversal" would swamp every real
    // interest/late/fee total on the card. classifyCharge returns null
    // for it (no charge keyword), so chargeTotals must leave every
    // category untouched.
    const totals = chargeTotals([
      { payee: 'BPPY CC PAYMENT BD0161', amount: 22380 },
    ]);
    expect(totals).toEqual({ interest: 0, late: 0, 'annual-fee': 0 });
  });

  it('mixed statement: categories accumulate independently, untracked lines ignored', () => {
    const totals = chargeTotals([
      { payee: 'ACME AGENCIES', amount: -3447.95 }, // ordinary spend
      { payee: 'FINANCE CHARGE', amount: -120 },
      { payee: 'LATE FEE', amount: -500 },
      { payee: 'IGST', amount: -21.6 }, // untracked (not a card cost)
      { payee: 'PETRO SURCHARGE', amount: -34.14 }, // untracked
      { payee: 'BPPY CC PAYMENT', amount: 22380 }, // bill payment, must not appear
    ]);
    expect(totals).toEqual({ interest: 120, late: 500, 'annual-fee': 0 });
  });
});

describe('annualFeeNet — trailing 365-day window', () => {
  const todayISO = '2026-07-29';

  it('a fee exactly 365 days old is inside the window', () => {
    expect(
      annualFeeNet(
        [{ payee: 'ANNUAL FEE', amount: -500, dateISO: '2025-07-29' }],
        todayISO,
      ),
    ).toBe(500);
  });

  it('a fee 366 days old is outside the window', () => {
    expect(
      annualFeeNet(
        [{ payee: 'ANNUAL FEE', amount: -500, dateISO: '2025-07-28' }],
        todayISO,
      ),
    ).toBe(0);
  });

  it('today itself is inside the window', () => {
    expect(
      annualFeeNet(
        [{ payee: 'MEMBERSHIP FEE', amount: -1500, dateISO: todayISO }],
        todayISO,
      ),
    ).toBe(1500);
  });

  it('sign-aware: a fee reversal inside the window nets to zero', () => {
    expect(
      annualFeeNet(
        [
          { payee: 'ANNUAL FEE', amount: -500, dateISO: '2026-01-01' },
          { payee: 'ANNUAL FEE REVERSAL', amount: 500, dateISO: '2026-01-15' },
        ],
        todayISO,
      ),
    ).toBe(0);
  });

  it('CATASTROPHIC-MODE PIN: a bill-payment credit never counts as a fee reversal', () => {
    expect(
      annualFeeNet(
        [
          { payee: 'ANNUAL FEE', amount: -500, dateISO: '2026-01-01' },
          {
            payee: 'BPPY CC PAYMENT BD0161',
            amount: 22380,
            dateISO: '2026-02-01',
          },
        ],
        todayISO,
      ),
    ).toBe(500);
  });

  it('interest/late/ordinary lines never leak into the fee figure', () => {
    expect(
      annualFeeNet(
        [
          { payee: 'FINANCE CHARGE', amount: -120, dateISO: '2026-03-01' },
          { payee: 'LATE FEE', amount: -350, dateISO: '2026-03-01' },
          { payee: 'COOL COFFEE', amount: -500, dateISO: '2026-03-01' },
        ],
        todayISO,
      ),
    ).toBe(0);
  });
});
