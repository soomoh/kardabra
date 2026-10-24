import { describe, expect, it } from 'vitest';
import { createAnonymizer } from '../../src/anonymize';
import { parseDate, cleanAmount } from '../../src/parser';

const SEED = 12345;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

describe('dates: same format, one secret offset for every format', () => {
  // Formats the parser reads today; "Sep 20, 2025" is checked by shape below
  // until the parser supports it (AUDIT #44).
  const inputs = [
    '20/09/2025',
    '20-09-2025',
    "20 Sep '25",
    '20-Sep-2025',
    '2025-09-20',
    '20/09/25',
  ];

  it('shifts "Mon DD, YYYY" and keeps its shape', () => {
    const out = createAnonymizer(SEED).text('Sep 20, 2025');
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{2}, \d{4}$/);
    expect(out).not.toBe('Sep 20, 2025');
  });

  it.each(inputs)('%s keeps its format and still parses', (input) => {
    const out = createAnonymizer(SEED).text(input);
    expect(out).not.toBe(input);
    expect(out.length).toBe(input.length);
    expect(() => parseDate(out)).not.toThrow();
  });

  it('shifts every format by the same number of days', () => {
    const anon = createAnonymizer(SEED);
    const offsets = inputs.map((i) =>
      daysBetween(parseDate(i), parseDate(anon.text(i))),
    );
    expect(new Set(offsets).size).toBe(1);
    expect(offsets[0]).toBeLessThanOrEqual(-30);
  });

  it('shifts dates inside text and keeps a time suffix', () => {
    const anon = createAnonymizer(SEED);
    const out = anon.text('20/09/2025 17:06:00');
    expect(parseDate(out)).not.toBe('2025-09-20');
    expect(out).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('amounts: format and sign kept, value scaled', () => {
  it.each([
    ['1,23,456.78', /^\d{1,2}(,\d{2})*,\d{3}\.\d{2}$/],
    ['12,345.67', /^[\d,]+\.\d{2}$/],
    ['925.65 Cr.', /^\d+\.\d{2} Cr\.$/],
    ['₹ 2,027.80', /^₹ [\d,]+\.\d{2}$/],
    ['Rs. 1,500.00', /^Rs\. [\d,]+\.\d{2}$/],
    ['-500.00', /^-\d+\.\d{2}$/],
    ['(500.00)', /^\(\d+\.\d{2}\)$/],
  ])('%s', (input, shape) => {
    const out = createAnonymizer(SEED).text(input);
    expect(out).toMatch(shape);
    expect(out).not.toBe(input);
  });

  it('scales every amount by one factor (ratios survive)', () => {
    const anon = createAnonymizer(SEED);
    const a = cleanAmount(anon.text('1,000.00'))!;
    const b = cleanAmount(anon.text('2,000.00'))!;
    expect(b / a).toBeCloseTo(2, 2);
  });

  // A zero turned non-zero would invent a balance on a "nothing due" statement.
  it.each(['INR 0', '0.00', '₹ 0.00'])('keeps zero: %s', (input) => {
    expect(createAnonymizer(SEED).text(input)).toBe(input);
  });

  it('scales a whole number after a currency marker', () => {
    const out = createAnonymizer(SEED).text('INR 2500');
    expect(out).toMatch(/^INR \d+$/);
    expect(out).not.toBe('INR 2500');
  });

  it('number(): scales amounts, fakes identifier-sized integers, keeps 0', () => {
    const anon = createAnonymizer(SEED);
    expect(anon.number(0)).toBe(0);
    expect(anon.number(1000)).not.toBe(1000);
    expect(Number.isInteger(anon.number(1000))).toBe(true);
    const id = anon.number(12269090508);
    expect(String(id)).toHaveLength(11);
    expect(id).not.toBe(12269090508);
  });
});

describe('card numbers, identifiers, words', () => {
  it('keeps mask and issuer prefix; maps the same card consistently', () => {
    const anon = createAnonymizer(SEED);
    const a = anon.text('Card No: 4823 41XX XXXX 4321');
    const b = anon.text('4823 41XX XXXX 4321');
    expect(a).toMatch(/^Card No: 4823 \d\dXX XXXX \d{4}$/);
    expect(a.endsWith(b)).toBe(true);
    expect(a).not.toContain('4321');
  });

  it('randomises other digit runs at the same length', () => {
    const out = createAnonymizer(SEED).text('Ref# ST574325291891941');
    expect(out).toMatch(/^\w{3}# [A-Z]{2}\d{15}$/);
    expect(out).not.toContain('574325291891941');
  });

  it('replaces non-structural words with same-length, same-case pseudo-words', () => {
    const anon = createAnonymizer(SEED);
    const out = anon.text('NAVEEN RAO Lakeview Road');
    expect(out).not.toMatch(/NAVEEN|RAO|Lakeview|Road/);
    const [w1, w2, w3] = out.split(' ');
    expect(w1).toMatch(/^[A-Z]{6}$/);
    expect(w2).toMatch(/^[A-Z]{3}$/);
    expect(w3).toMatch(/^[A-Z][a-z]{7}$/);
  });

  it('keeps structural labels and keywords the parser depends on', () => {
    const anon = createAnonymizer(SEED);
    for (const label of [
      'Total Amount Due',
      'Payment Due Date',
      'Debit / Credit',
      'BBPS Payment received',
      'LATE PAYMENT FEE',
      'Cr',
    ]) {
      expect(anon.text(label)).toBe(label);
    }
    expect(anon.keptVerbatim()).toContain('Total Amount Due');
  });

  it('maps the same merchant to the same pseudo-word', () => {
    const anon = createAnonymizer(SEED);
    expect(anon.text('SWIGGY BANGALORE')).toBe(anon.text('SWIGGY BANGALORE'));
  });

  it('is deterministic for a seed and different across seeds', () => {
    expect(createAnonymizer(1).text('JANE DOE 20/09/2025')).toBe(
      createAnonymizer(1).text('JANE DOE 20/09/2025'),
    );
    expect(createAnonymizer(1).text('JANE DOE')).not.toBe(
      createAnonymizer(2).text('JANE DOE'),
    );
  });
});

// Review fix: a name that is also a vocabulary word must reach the reviewer.
it('lists vocabulary words kept inside changed text', () => {
  const anon = createAnonymizer(SEED);
  const out = anon.text('JUNE MATHEW');
  expect(out.startsWith('JUNE ')).toBe(true);
  expect(anon.keptVerbatim()).not.toContain('JUNE MATHEW');
  expect(anon.keptWords()).toContain('JUNE');
});

// Review fix: month-first files shift as month-first (not random digits).
it('shifts month-first dates when told the file is month-first', () => {
  const anon = createAnonymizer(SEED, 'mdy');
  const out = anon.text('12/31/2025');
  expect(out).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  expect(parseDate(out, 'mdy')).not.toBe('2025-12-31');
});
