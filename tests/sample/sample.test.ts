import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { parseStatementBytes } from '../../src/parser';
import { planImport } from '../../src/import/plan';
import { commitImport } from '../../src/import/commit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteCardCascade,
  getAllCards,
  getCyclesForCard,
  getStatementsForCard,
  openKardabraDb,
  putCard,
} from '../../src/db/db';
import {
  getSampleCardId,
  loadSampleData,
  resetSampleData,
  sampleStatementFiles,
} from '../../src/sample/sample';

describe('sampleStatementFiles', () => {
  it.each([
    // [today, statement dates oldest first, newest due date]
    [
      '2026-11-24',
      ['2026-08-14', '2026-09-14', '2026-10-14', '2026-11-14'],
      '2026-12-04',
    ],
    // today − 10 days lands on the 29th: capped to the 28th, across a year end.
    [
      '2026-01-08',
      ['2025-09-28', '2025-10-28', '2025-11-28', '2025-12-28'],
      '2026-01-17',
    ],
  ])('dates the statements back from %s', (today, statementDates, due) => {
    const files = sampleStatementFiles(today);
    const slash = (iso: string) => iso.split('-').reverse().join('/');
    expect(files.map((f) => f.text.split('\n')[0])).toEqual(
      statementDates.map((d) => `Statement Date~${slash(d)}`),
    );
    expect(files[3].text.split('\n')[1]).toBe(`Payment Due Date~${slash(due)}`);
  });
});

describe('sample data in the database', () => {
  const today = '2026-11-24';

  beforeEach(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('kardabra');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });

  it('imports four statements onto one card named Sample card', async () => {
    const db = await openKardabraDb();
    await loadSampleData(db, today);

    const cards = await getAllCards(db);
    expect(cards.map((c) => [c.nickname, c.last4])).toEqual([
      ['Sample card', null],
    ]);
    const statements = await getStatementsForCard(db, cards[0].id);
    // Newest first, as the card page lists them.
    expect(statements.map((s) => [s.period, s.txnCount])).toEqual([
      ['2026-11', 13],
      ['2026-10', 8],
      ['2026-09', 7],
      ['2026-08', 4],
    ]);
    const cycles = await getCyclesForCard(db, cards[0].id);
    expect(cycles.at(-1)?.dueDateISO).toBe('2026-12-04');
    expect(await getSampleCardId(db)).toBe(cards[0].id);
    db.close();
  });

  it('a real statement imported later never lands on the sample card', async () => {
    const db = await openKardabraDb();
    await loadSampleData(db, today);
    const sampleId = await getSampleCardId(db);
    const name = 'hdfc_style.csv';
    const parsed = parseStatementBytes(
      name,
      readFileSync(new URL(`../fixtures/${name}`, import.meta.url)),
    );
    const [outcome] = planImport(
      [{ fileName: name, parsed }],
      await getAllCards(db),
      await db.getAll('statements'),
    );
    expect(outcome.kind === 'new-statement' && outcome.cardRef.kind).toBe(
      'new',
    );

    await commitImport(db, [outcome], {
      nicknames: new Map([['4321', 'My card']]),
      dueDays: new Map(),
    });
    await resetSampleData(db, today);
    const real = (await getAllCards(db)).find((c) => c.nickname === 'My card');
    expect(real?.id).not.toBe(sampleId);
    expect((await getStatementsForCard(db, real!.id)).length).toBe(1);
    db.close();
  });

  it('loads once, even when two loads overlap', async () => {
    const db = await openKardabraDb();
    expect(
      await Promise.all([loadSampleData(db, today), loadSampleData(db, today)]),
    ).toEqual([true, false]);
    expect(await loadSampleData(db, today)).toBe(false);
    expect((await getAllCards(db)).length).toBe(1);
    db.close();
  });

  it('re-dates a sample loaded on an earlier day', async () => {
    const db = await openKardabraDb();
    await loadSampleData(db, '2026-10-01');
    expect(await loadSampleData(db, today)).toBe(true);
    const cards = await getAllCards(db);
    expect(cards.length).toBe(1);
    const cycles = await getCyclesForCard(db, cards[0].id);
    expect(cycles.at(-1)?.dueDateISO).toBe('2026-12-04');
    expect(await db.count('statements')).toBe(4);
    db.close();
  });

  it('reset undoes changes and leaves real cards alone', async () => {
    const db = await openKardabraDb();
    await putCard(db, {
      id: 'real',
      last4: '1111',
      nickname: 'My card',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await loadSampleData(db, today);
    const before = await getSampleCardId(db);
    await putCard(db, {
      ...(await db.get('cards', before!))!,
      nickname: 'Renamed',
    });
    expect(await resetSampleData(db, today)).toBe(true);

    const after = await getSampleCardId(db);
    expect(after).not.toBe(before);
    expect((await getAllCards(db)).map((c) => c.nickname).sort()).toEqual([
      'My card',
      'Sample card',
    ]);
    expect(await db.count('statements')).toBe(4);
    db.close();
  });

  it('loads again once its card is deleted', async () => {
    const db = await openKardabraDb();
    await loadSampleData(db, today);
    const id = await getSampleCardId(db);
    await deleteCardCascade(db, id!);
    expect(await getSampleCardId(db)).toBeNull();
    expect(await loadSampleData(db, today)).toBe(true);
    db.close();
  });
});
