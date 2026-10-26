import { describe, expect, it } from 'vitest';
import { parseRows } from '../../src/parser';
import { issuerFromRows } from '../../src/parser/issuer';
import { confirmedIssuer } from '../../src/lib/bankDetect';

const table = [
  ['Date', 'Description', 'Amount'],
  ['01/10/2025', 'PAYMENT RECEIVED HDFC NETBANKING', '5000.00 Cr'],
  ['02/10/2025', 'SHOP', '100.00'],
];

describe('issuer', () => {
  it('reads the issuer from the header block', () => {
    const rows = [
      ['SBI Card Statement'],
      ['Statement Date', '13/10/2025'],
      ...table,
    ];
    expect(parseRows('x.csv', rows).issuer).toBe('SBI Card');
  });

  it('ignores banks named in transaction rows', () => {
    const rows = [['Statement Date', '13/10/2025'], ...table];
    expect(parseRows('x.csv', rows).issuer).toBeUndefined();
  });

  it('gives no answer when the header names two issuers', () => {
    const rows = [['ICICI Bank'], ['Pay via HDFC Bank NEFT'], ...table];
    expect(issuerFromRows(rows, 2)).toBeUndefined();
  });

  it.each([
    ['Kotak Mahindra Bank - Credit Card Statement', 'Kotak Mahindra Bank'],
    ['IDFC FIRST Bank', 'IDFC FIRST Bank'],
    ['South Indian Bank', 'South Indian Bank'],
    ['Indian Bank credit card', 'Indian Bank'],
    ['American Express Statement', 'American Express'],
    ['SBI CARDS AND PAYMENT SERVICES LTD', 'SBI Card'],
  ])('%s → %s', (header, issuer) => {
    expect(issuerFromRows([[header], ...table], 1)).toBe(issuer);
  });

  it("doesn't match words that merely contain a name", () => {
    expect(issuerFromRows([['Taxis and Axis Mall']], 1)).toBeUndefined();
  });
});

describe('confirmedIssuer', () => {
  it('trusts the header when the file name agrees or says nothing', () => {
    expect(
      confirmedIssuer({ issuer: 'HDFC Bank', fileName: 'hdfc_oct.pdf' }),
    ).toBe('HDFC Bank');
    expect(
      confirmedIssuer({ issuer: 'Kotak Mahindra Bank', fileName: 'st.pdf' }),
    ).toBe('Kotak Mahindra Bank');
  });
  it('trusts neither when they disagree', () => {
    expect(
      confirmedIssuer({ issuer: 'HDFC Bank', fileName: 'Axis_statement.pdf' }),
    ).toBeUndefined();
  });
});
