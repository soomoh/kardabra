import { describe, expect, it } from 'vitest';
import { statementsSummary } from '../../src/lib/bankDetect';

describe('statementsSummary — the collapsed locked-files line', () => {
  it('names the bank when there is only one', () => {
    expect(statementsSummary(['SBI_oct.pdf'])).toBe(
      '1 statement from SBI Card',
    );
    expect(statementsSummary(['hdfc1.pdf', 'HDFC2.pdf'])).toBe(
      '2 statements from HDFC Bank',
    );
  });
  it('counts banks when there are several', () => {
    expect(statementsSummary(['hdfc.pdf', 'sbi.pdf', 'axis.pdf'])).toBe(
      '3 statements from 3 banks',
    );
  });
  it('just the count when any bank is unknown', () => {
    expect(statementsSummary(['hdfc.pdf', 'statement.pdf'])).toBe(
      '2 statements',
    );
  });
});
