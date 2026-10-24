import { describe, expect, it } from 'vitest';
import { cardIdKey, transactionIds } from '../../src/lib/txnId';

const coffee = { dateISO: '2025-09-20', amount: -120, payee: 'CAFE' };
const book = { dateISO: '2025-09-21', amount: -450.5, payee: 'BOOKS' };

describe('transactionIds', () => {
  it('is stable across re-imports of the same statement', () => {
    expect(transactionIds('4321', [coffee, book])).toEqual(
      transactionIds('4321', [coffee, book]),
    );
  });

  it('keeps identical rows distinct by occurrence', () => {
    const [a, b] = transactionIds('4321', [coffee, coffee]);
    expect(a).not.toBe(b);
  });

  it('differs by card, date, amount and payee', () => {
    const [base] = transactionIds('4321', [coffee]);
    expect(transactionIds('9999', [coffee])[0]).not.toBe(base);
    expect(
      transactionIds('4321', [{ ...coffee, dateISO: '2025-09-21' }])[0],
    ).not.toBe(base);
    expect(transactionIds('4321', [{ ...coffee, amount: 120 }])[0]).not.toBe(
      base,
    );
    expect(transactionIds('4321', [{ ...coffee, payee: 'TEA' }])[0]).not.toBe(
      base,
    );
  });

  it('ignores payee case and surrounding spaces', () => {
    expect(transactionIds('4321', [{ ...coffee, payee: ' cafe ' }])).toEqual(
      transactionIds('4321', [coffee]),
    );
  });

  it('has a fixed format', () => {
    expect(transactionIds('4321', [coffee])[0]).toMatch(/^t[0-9a-f]{16}$/);
  });
});

it('cardIdKey prefers last-4 and falls back to the card id', () => {
  expect(cardIdKey({ id: 'abc', last4: '4321' })).toBe('4321');
  expect(cardIdKey({ id: 'abc', last4: null })).toBe('abc');
});
