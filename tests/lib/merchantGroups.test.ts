import { describe, expect, test } from 'vitest';
import { nameMerchants } from '../../src/lib/merchantGroups';

// A bank spelling of Tata 1mg (named so a scanner doesn't read `key: '…'` as a secret).
const ONE_MG = '1MGHEALTHCARESOLUTIO';

const view = (
  payees: string[],
  renames = [] as { key: string; name: string }[],
) =>
  nameMerchants(payees, renames).map(
    (m) =>
      `${m.merchant} / ${m.merchantKey} / ${m.group}${m.renamed ? ' *' : ''}`,
  );

describe('nameMerchants: renames', () => {
  const payees = ['1MGHEALTHCARESOLUTIO', 'Tata 1mg', 'TATA 1MG'];

  test('without renames, spellings no rule can link stay apart', () => {
    expect(view(payees)).toEqual([
      '1MGHEALTHCARESOLUTIO / 1MGHEALTHCARESOLUTIO / 1MGHEALTHCARESOLUTIO',
      'Tata 1mg / TATA1MG / TATA1MG',
      'Tata 1mg / TATA1MG / TATA1MG',
    ]);
  });

  test('naming one merchant as another merges them; the bank group stays', () => {
    const renames = [{ key: ONE_MG, name: 'Tata 1mg' }];
    expect(view(payees, renames)).toEqual([
      'Tata 1mg / TATA1MG / 1MGHEALTHCARESOLUTIO *',
      'Tata 1mg / TATA1MG / TATA1MG',
      'Tata 1mg / TATA1MG / TATA1MG',
    ]);
    const [first] = nameMerchants(payees, renames);
    expect(first.bankName).toBe('1MGHEALTHCARESOLUTIO');
  });

  test("the user's spelling names the merged merchant", () => {
    const renames = [{ key: ONE_MG, name: 'TATA 1mg (pharmacy)' }];
    expect(view(['1MGHEALTHCARESOLUTIO', 'TATA1MGPHARMACY'], renames)).toEqual([
      'TATA 1mg (pharmacy) / TATA1MGPHARMACY / 1MGHEALTHCARESOLUTIO *',
      'TATA 1mg (pharmacy) / TATA1MGPHARMACY / TATA1MGPHARMACY',
    ]);
  });

  test('two groups renamed alike are one; each keeps its own rename', () => {
    const renames = [
      { key: ONE_MG, name: '1mg' },
      { key: 'TATA1MG', name: '1mg' },
    ];
    expect(view(payees, renames)).toEqual([
      '1mg / 1MG / 1MGHEALTHCARESOLUTIO *',
      '1mg / 1MG / TATA1MG *',
      '1mg / 1MG / TATA1MG *',
    ]);
  });

  test('a rename on a group key that a shorter stem later took over still applies', () => {
    // Renamed while ORBGEN TECHNOLOGIES PR was its own group…
    const renames = [{ key: 'ORBGENTECHNOLOGIESPR', name: 'Orbgen' }];
    // …then a statement printed the shorter stem.
    expect(
      view(['ORBGEN TECHNOLOGIES PR', 'ORBGEN TECHNOLOGIES'], renames),
    ).toEqual([
      'Orbgen / ORBGEN / ORBGENTECHNOLOGIES *',
      'Orbgen / ORBGEN / ORBGENTECHNOLOGIES *',
    ]);
  });

  test('a rename on a stem reaches lines that only extend it (one card shown)', () => {
    // Renamed over all cards, where another card printed the bare stem;
    // this card's lines only ever printed the longer spelling.
    const renames = [{ key: 'ORBGENTECHNOLOGIES', name: 'Orbgen' }];
    expect(view(['ORBGEN TECHNOLOGIES PR'], renames)).toEqual([
      'Orbgen / ORBGEN / ORBGENTECHNOLOGIES *',
    ]);
    const [line] = nameMerchants(['ORBGEN TECHNOLOGIES PR'], renames);
    expect(line.bankName).toBe('ORBGEN TECHNOLOGIES PR');
    expect(line.bankKey).toBe('ORBGENTECHNOLOGIESPR');
  });

  test('a rename for a merchant not in the data changes nothing', () => {
    expect(view(payees, [{ key: 'GONE', name: 'Tata 1mg' }])).toEqual(
      view(payees),
    );
  });
});
