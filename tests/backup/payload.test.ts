/**
 * The restore boundary: every malformed backup is refused with the first
 * problem in plain words, and a good one comes back as fresh records built
 * from the allowed fields only.
 */
import { describe, expect, it } from 'vitest';
import { parseBackupPayload } from '../../src/backup/payload';
import { sampleData } from './sample';

const CREATED = '2026-10-30T08:00:00.000Z';
const good = () => ({ createdAt: CREATED, ...sampleData() });
type Payload = ReturnType<typeof good>;
/** Round-tripped through JSON, as a real backup is. */
const parse = (payload: unknown) =>
  parseBackupPayload(JSON.parse(JSON.stringify(payload)));

describe('parseBackupPayload', () => {
  it('returns every record unchanged', () => {
    expect(parse(good())).toEqual({ ok: true, data: good() });
  });

  it('accepts an empty backup', () => {
    const empty = {
      createdAt: CREATED,
      cards: [],
      statements: [],
      transactions: [],
      cycles: [],
    };
    expect(parse(empty)).toEqual({ ok: true, data: empty });
  });

  it('drops unknown keys and never lets __proto__ through', () => {
    // JSON.parse makes "__proto__" an own key; built records must not carry it.
    const text = JSON.stringify(good()).replace(
      '"id":"card-a"',
      '"__proto__":{"polluted":true},"extra":1,"id":"card-a"',
    );
    const parsed = parseBackupPayload(JSON.parse(text));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const card = parsed.data.cards[0];
    expect(Object.hasOwn(card, '__proto__')).toBe(false);
    expect(Object.hasOwn(card, 'extra')).toBe(false);
    expect(Object.getPrototypeOf(card)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts names and descriptions as long as the app lets anyone write', () => {
    // No input caps them, so a backup the app made must still restore.
    const p = good();
    p.cards[0].nickname = 'n'.repeat(5000);
    p.transactions[0].payee = 'p'.repeat(20_000);
    p.statements[0].fileName = 'f'.repeat(2000);
    expect(parse(p)).toEqual({ ok: true, data: p });
  });

  it('accepts a negative spend (refunds outweighing purchases)', () => {
    const p = good();
    p.cycles[1].spend = -250;
    expect(parse(p).ok).toBe(true);
  });

  it('accepts a paid date stored as a date and time (older data)', () => {
    const p = good();
    p.cycles[0].paidAt = '2026-10-15T07:30:00.000Z';
    expect(parse(p).ok).toBe(true);
  });

  const refused: [string, (p: Payload) => unknown, string][] = [
    ['not an object', () => 'hello', 'The backup isn’t readable'],
    [
      'no cards list',
      (p) => ({ ...p, cards: undefined }),
      'the list of cards is missing',
    ],
    [
      'amount as text',
      (p) => {
        (p.transactions[1] as { amount: unknown }).amount = '12';
      },
      'Transaction 2 has an amount that isn’t a number',
    ],
    [
      'amount NaN (null in JSON)',
      (p) => {
        p.transactions[0].amount = NaN;
      },
      'Transaction 1 has an amount that isn’t a number',
    ],
    [
      'impossible date',
      (p) => {
        p.transactions[2].dateISO = '2026-02-30';
      },
      'Transaction 3 has a date that isn’t a date',
    ],
    [
      'date in another format',
      (p) => {
        p.transactions[0].dateISO = '03/09/2026';
      },
      'Transaction 1 has a date that isn’t a date',
    ],
    [
      'month 13',
      (p) => {
        p.statements[0].period = '2026-13';
      },
      'Statement 1 has a month that isn’t a month',
    ],
    [
      'due day 32',
      (p) => {
        p.cards[0].dueDay = 32;
      },
      'Card 1 has a due day that isn’t 1 to 31',
    ],
    [
      'due day 1.5',
      (p) => {
        p.cards[0].dueDay = 1.5;
      },
      'Card 1 has a due day that isn’t a whole number',
    ],
    [
      'unknown fee kind',
      (p) => {
        (p.cards[0].feeLabel as { type: string }).type = 'FREE';
      },
      'Card 1 has an annual fee of an unknown kind',
    ],
    [
      'currency in words',
      (p) => {
        p.statements[0].currency = 'rupees';
      },
      'Statement 1 has a currency that isn’t a currency code',
    ],
    [
      'negative transaction count',
      (p) => {
        p.statements[1].txnCount = -1;
      },
      'Statement 2 has a transaction count that isn’t a whole number',
    ],
    [
      'card with no name',
      (p) => {
        delete (p.cards[1] as { nickname?: string }).nickname;
      },
      'Card 2 has no readable name',
    ],
    [
      'huge description',
      (p) => {
        p.transactions[0].payee = 'x'.repeat(100_001);
      },
      'Transaction 1 has no readable description',
    ],
    [
      'unknown bill source',
      (p) => {
        (p.cycles[1] as { source: string }).source = 'guess';
      },
      'Bill 2 has an unknown source',
    ],
    [
      'an hour past 23',
      (p) => {
        p.cards[0].createdAt = '2026-09-01T99:99:99.000Z';
      },
      'Card 1 has a creation date that isn’t a date and time',
    ],
    [
      'an absurd amount',
      (p) => {
        p.transactions[0].amount = -1e300;
      },
      'Transaction 1 has an amount that’s far too large',
    ],
    [
      'payment choice not a list',
      (p) => {
        (p.cycles[0] as { paymentOverride: unknown }).paymentOverride = {};
      },
      'Bill 1 has an unreadable bill payment choice',
    ],
    [
      'statement for a missing card',
      (p) => {
        p.statements[1].cardId = 'card-z';
      },
      'Statement 2 belongs to a card that isn’t there',
    ],
    [
      'transaction for a missing statement',
      (p) => {
        p.transactions[2].statementId = 'st-z';
      },
      'Transaction 3 belongs to a statement that isn’t there',
    ],
    [
      'transaction whose card disagrees with its statement',
      (p) => {
        p.transactions[2].cardId = 'card-a';
      },
      'Transaction 3 belongs to a statement that isn’t there',
    ],
    [
      'bill for a missing card',
      (p) => {
        p.cycles[1].cardId = 'card-z';
      },
      'Bill 2 belongs to a card that isn’t there',
    ],
    [
      'two cards with one id',
      (p) => {
        p.cards[1].id = 'card-a';
      },
      'Card 2 repeats another card',
    ],
    [
      'two statements for one card and month',
      (p) => {
        p.statements[1].cardId = 'card-a';
      },
      'Statement 2 is a second statement for the same card and month',
    ],
    [
      'two bills for one card and month',
      (p) => {
        p.cycles[1].cardId = 'card-a';
      },
      'Bill 2 repeats another bill',
    ],
  ];

  it.each(refused)('refuses %s', (_name, change, problem) => {
    const p = good();
    const changed = change(p) ?? p;
    expect(parse(changed)).toEqual({ ok: false, problem });
  });

  it('names only the first problem', () => {
    const p = good();
    p.transactions[0].amount = NaN;
    p.transactions[1].dateISO = 'nope';
    expect(parse(p)).toEqual({
      ok: false,
      problem: 'Transaction 1 has an amount that isn’t a number',
    });
  });
});
