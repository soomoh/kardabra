import { describe, expect, it } from 'vitest';
import { olderBillStatus } from '../../src/lib/olderBill';
import { billUnderpaid, priorExpectedDue } from '../../src/lib/spend';

const june = { period: '2025-06', totalDue: 10_000 };

describe('olderBillStatus — says only what the statements show', () => {
  it('unknown when the next month (where the payment shows) is missing', () => {
    // June, then September: July would have shown June's payment.
    expect(
      olderBillStatus(
        june,
        { spend: 9000 },
        { period: '2025-09', credits: 50_000 },
      ),
    ).toEqual({ kind: 'unknown', missing: '2025-07' });
  });

  it("covered when the next month's credits cover the bill", () => {
    expect(
      olderBillStatus(june, undefined, { period: '2025-07', credits: 10_000 }),
    ).toEqual({ kind: 'covered', by: '2025-07' });
  });

  it('not covered when they fall short', () => {
    expect(
      olderBillStatus(june, undefined, { period: '2025-07', credits: 4_000 }),
    ).toEqual({ kind: 'not-covered', by: '2025-07' });
  });

  it("the user's own mark wins, even without the next statement", () => {
    expect(olderBillStatus(june, { paidAt: '2025-07-01' }, undefined)).toEqual({
      kind: 'marked-paid',
    });
  });

  it('a ₹0 bill had nothing to pay', () => {
    expect(
      olderBillStatus({ period: '2025-06', totalDue: 0 }, undefined, {
        period: '2025-07',
        credits: 0,
      }),
    ).toEqual({ kind: 'nothing-due' });
  });

  it('no bill amount to judge against: unknown, never a claim', () => {
    expect(
      olderBillStatus({ period: '2025-06' }, undefined, {
        period: '2025-07',
        credits: 100,
      }),
    ).toEqual({ kind: 'no-amount' });
    // A net-credit month estimated from spend isn't "nothing was due".
    expect(
      olderBillStatus(
        { period: '2025-06' },
        { spend: -200 },
        {
          period: '2025-07',
          credits: 0,
        },
      ),
    ).toEqual({ kind: 'no-amount' });
  });

  it('agrees with the newer row\'s "didn\'t cover" hint', () => {
    for (const credits of [0, 4_000, 9_940, 9_960, 10_000, 12_000]) {
      const status = olderBillStatus(june, undefined, {
        period: '2025-07',
        credits,
      });
      expect(status.kind === 'not-covered').toBe(
        billUnderpaid(credits, priorExpectedDue('2025-07', june, undefined)),
      );
    }
  });

  it('crosses the year', () => {
    expect(
      olderBillStatus({ period: '2025-12', totalDue: 500 }, undefined, {
        period: '2026-01',
        credits: 500,
      }),
    ).toEqual({ kind: 'covered', by: '2026-01' });
  });
});
