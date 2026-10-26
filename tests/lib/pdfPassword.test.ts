import { describe, expect, it } from 'vitest';
import { parseDob, passwordCandidates } from '../../src/lib/pdfPassword';
import { bankFromFileName } from '../../src/lib/bankDetect';

// Fabricated cardholder.
const jane = {
  name: 'Jane Doe',
  dob: { day: 20, month: 10, year: 1990 },
  last4s: ['4242'],
};
const passwords = (bank: Parameters<typeof passwordCandidates>[1]) =>
  passwordCandidates(jane, bank).map((c) => c.password);

describe('passwordCandidates', () => {
  it.each([
    ['hdfc', 'JANE2010', 'name4U+ddmm'],
    ['icici', 'jane2010', 'name4L+ddmm'],
    ['axis', 'JANE2010', 'name4U+ddmm'],
    ['sbi', '201019904242', 'ddmmyyyy+last4'],
  ] as const)(
    '%s tries its documented pattern first',
    (bank, password, pattern) => {
      const [first] = passwordCandidates(jane, bank);
      expect(first).toEqual({ pattern, password });
    },
  );

  it('tries every bank’s patterns, so a wrong or unknown bank still opens', () => {
    for (const bank of ['hdfc', 'icici', 'sbi', null] as const) {
      expect(passwords(bank)).toEqual(
        expect.arrayContaining([
          'JANE2010',
          'jane2010',
          '201019904242',
          'JANE4242',
          '20101990',
        ]),
      );
    }
  });

  it('never repeats a password', () => {
    const list = passwords(null);
    expect(new Set(list).size).toBe(list.length);
  });

  it('uses letters only for the first four of the name', () => {
    const [first] = passwordCandidates({ ...jane, name: "O'Neil Ray" }, 'hdfc');
    expect(first.password).toBe('ONEI2010');
  });

  it('skips last-4 patterns when no card digits were given', () => {
    const list = passwordCandidates({ ...jane, last4s: [] }, 'sbi');
    expect(list.every((c) => !c.pattern.includes('last4'))).toBe(true);
  });
});

describe('parseDob', () => {
  it.each([
    '20/10/1990',
    '20-10-1990',
    '20.10.1990',
    ' 20/10/1990 ',
    '20101990',
  ])('%s', (text) => {
    expect(parseDob(text)).toEqual({ day: 20, month: 10, year: 1990 });
  });
  it.each(['31/02/1990', '1990-10-20', '20/10/90', '', '2010199', '31021990'])(
    'rejects %s',
    (text) => {
      expect(parseDob(text)).toBeNull();
    },
  );
});

describe('bankFromFileName', () => {
  it.each([
    ['HDFC_Regalia_Oct2025.pdf', 'hdfc'],
    ['ICICI Coral statement.pdf', 'icici'],
    ['axis-myzone.pdf', 'axis'],
    ['8813129404745270_17012026.pdf', 'sbi'],
    ['SBI Card.pdf', 'sbi'],
    ['scapia_nov.pdf', 'federal'],
    ['Indian Bank card.pdf', 'indian_bank'],
    ['4386XXXXXXXX4219.pdf', 'hdfc'],
    ['4111XXXXXXXX1111_000001_Retail_Coral_NORM.pdf', 'icici'],
    ['4000XXXXXXXXXX00_01-01-2025_1.pdf', 'hdfc'],
    ['Credit Card Statement.pdf', 'axis'],
    ['Credit Card Statement (1).pdf', 'axis'],
    ['statement.pdf', null],
    ['South Indian Bank.pdf', null],
  ] as const)('%s → %s', (name, bank) => {
    expect(bankFromFileName(name)).toBe(bank);
  });
});
