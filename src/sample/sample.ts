/**
 * Sample data for the demo site (lib/sites.ts): four months of one
 * fabricated card, so a visitor can see every screen (dashboard, card page,
 * Insights) before trusting the app with a real statement. The statements are generated as CSV text and
 * go through the real parser and import, so the sample can never show
 * something a real import wouldn't. Dates count back from today, so the
 * newest bill is always due in about ten days rather than long overdue.
 */

import type { IDBPDatabase } from 'idb';
import type { KardabraSchema } from '../db/schema';
import {
  deleteCardCascade,
  getSetting,
  getStatementsForCard,
  putSetting,
} from '../db/db';
import { addDaysISO, todayISO } from '../lib/dates';
import { parseStatementBytes } from '../parser';
import {
  NEW_CARD,
  cardInputKey,
  planImport,
  type ParseResult,
} from '../import/plan';
import { commitImport } from '../import/commit';

/** Which card is the sample: its id, in the settings store. A setting, not
 * a field on the card, so backups and the card record keep their shape;
 * a restored backup carries the sample as an ordinary card. */
const SETTING_KEY = 'sampleCardId';
export const SAMPLE_NICKNAME = 'Sample card';

/** [days after the previous statement date, payee, amount, debit/credit].
 * Days stay under 28 so every line falls inside its cycle in any month. */
type Line = [day: number, payee: string, amount: number, side: 'Dr' | 'Cr'];

/** Shaped to fill every Insights section: a subscription with a price rise
 * and one starting within the data, fees with GST, interest, forex markup,
 * a refund, a high balance against the limit, and a doubled charge. The
 * last bill is part-paid, which is what brings the late fee and interest. */
const MONTHS: { totalDue: number; lines: Line[] }[] = [
  {
    totalDue: 6449,
    lines: [
      [2, 'PAYMENT RECEIVED THANK YOU', 5200, 'Cr'],
      [5, 'NETFLIX.COM', 499, 'Dr'],
      [8, 'SWIGGY BANGALORE', 1450, 'Dr'],
      [19, 'AMAZON RETAIL BLR', 4500, 'Dr'],
    ],
  },
  {
    totalDue: 5248,
    lines: [
      [2, 'PAYMENT RECEIVED THANK YOU', 6449, 'Cr'],
      [5, 'NETFLIX.COM', 499, 'Dr'],
      [7, 'SPOTIFY INDIA', 119, 'Dr'],
      [11, 'SWIGGY BANGALORE', 2130, 'Dr'],
      [20, 'AMAZON RETAIL BLR', 2500, 'Dr'],
      [24, 'WWWBIGBASKETCOM', 1240, 'Dr'],
      [26, '1.75% on all DCC Transaction', 42.5, 'Dr'],
    ],
  },
  {
    totalDue: 4598,
    lines: [
      [2, 'PAYMENT RECEIVED THANK YOU', 5248, 'Cr'],
      [5, 'NETFLIX.COM', 499, 'Dr'],
      [7, 'SPOTIFY INDIA', 119, 'Dr'],
      [14, 'SWIGGY BANGALORE', 980, 'Dr'],
      [19, 'AMAZON RETAIL BLR', 3200, 'Dr'],
      [20, 'AMAZON RETAIL BLR', 200, 'Cr'],
      [24, 'WWWBIGBASKETCOMGURGOAN', 980, 'Dr'],
      [26, '1.75% on all DCC Transaction', 42.5, 'Dr'],
    ],
  },
  {
    totalDue: 72641.25,
    lines: [
      [2, 'PAYMENT RECEIVED THANK YOU', 4000, 'Cr'],
      [5, 'NETFLIX.COM', 649, 'Dr'],
      [7, 'SPOTIFY INDIA', 119, 'Dr'],
      [9, 'CROMA ELECTRONICS MUMBAI', 65000, 'Dr'],
      [12, 'COOL COFFEE BANGALORE', 320, 'Dr'],
      [12, 'COOL COFFEE BANGALORE', 320, 'Dr'],
      [15, 'SWIGGY BANGALORE', 1720, 'Dr'],
      [17, 'HOTEL LISBOA PT', 3800, 'Dr'],
      [17, 'CONSOLIDATED FCY MARKUP FEE', 133, 'Dr'],
      [17, 'GST ON FOREX MARKUP', 23.94, 'Dr'],
      [20, 'LATE PAYMENT FEE', 700, 'Dr'],
      [20, 'IGST ON LATE FEE', 126, 'Dr'],
      [27, 'FINANCE CHARGES', 450, 'Dr'],
    ],
  },
];

const money = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2 });

/** 'YYYY-MM-DD' → 'DD/MM/YYYY', the layout the CSV below uses. */
const slashDate = (iso: string) => iso.split('-').reverse().join('/');

/** The same day of the month, `count` months earlier (day ≤ 28, so it
 * always exists). */
function monthsBefore(iso: string, count: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const index = year * 12 + (month - 1) - count;
  const mm = String((index % 12) + 1).padStart(2, '0');
  return `${Math.floor(index / 12)}-${mm}-${String(day).padStart(2, '0')}`;
}

/** The newest sample statement's date for `today`: ten days back, the day
 * capped at 28 so every month has the same statement day. */
function newestStatementDate(today: string): string {
  const [y, m, d] = addDaysISO(today, -10).split('-');
  return `${y}-${m}-${String(Math.min(Number(d), 28)).padStart(2, '0')}`;
}

/** The sample statements as files, newest dated so its bill falls due
 * about ten days after `today`. HDFC-style `~`-separated CSV. */
export function sampleStatementFiles(
  today: string,
): { name: string; text: string }[] {
  const newest = newestStatementDate(today);
  return MONTHS.map(({ totalDue, lines }, index) => {
    const statementDate = monthsBefore(newest, MONTHS.length - 1 - index);
    const previous = monthsBefore(statementDate, 1);
    const text = [
      `Statement Date~${slashDate(statementDate)}`,
      `Payment Due Date~${slashDate(addDaysISO(statementDate, 20))}`,
      `Total Amount Due~${money(totalDue)}`,
      `Minimum Amount Due~${money(Math.round(totalDue * 5) / 100)}`,
      'Credit Limit~2,00,000.00',
      '',
      'Date~Transaction Details~Amount~Debit/Credit',
      ...lines.map(
        ([day, payee, amount, side]) =>
          `${slashDate(addDaysISO(previous, day))}~${payee}~${money(amount)}~${side}`,
      ),
    ].join('\n');
    return {
      name: `sample_${statementDate.slice(0, 7)}.csv`,
      text: text + '\n',
    };
  });
}

/** The sample card's id while it exists; null once removed (by the
 * card's own Delete, an erase or a reset). */
export async function getSampleCardId(
  db: IDBPDatabase<KardabraSchema>,
): Promise<string | null> {
  const id = await getSetting(db, SETTING_KEY);
  if (typeof id !== 'string') return null;
  return (await db.get('cards', id)) === undefined ? null : id;
}

/** Import the sample as its own card. The statements carry no card number,
 * so no real statement imported later can be matched to the sample card by
 * its last four digits (and deleted with it). Without a number, each file
 * would become a card of its own: the first creates the card, the rest are
 * assigned to it. A sample dated for another day (a visitor returning
 * later) is replaced, so its bill is never overdue. Returns whether it
 * loaded anything: false when today's sample is already there. */
export function loadSampleData(
  db: IDBPDatabase<KardabraSchema>,
  today = todayISO(),
): Promise<boolean> {
  return serially(() => load(db, today));
}

/** Put the sample back as it first loaded: the visitor's changes (paid
 * marks, renames, a deleted card) undone. */
export function resetSampleData(
  db: IDBPDatabase<KardabraSchema>,
  today = todayISO(),
): Promise<boolean> {
  return serially(async () => {
    await remove(db);
    return load(db, today);
  });
}

/** Loads and resets run one at a time across every tab: two overlapping
 * loads (tabs reloading together after an erase, a Reset during the first
 * load) would each find no sample card and make one. */
function serially<T>(task: () => Promise<T>): Promise<T> {
  return navigator.locks.request('kardabra-sample', task);
}

async function load(
  db: IDBPDatabase<KardabraSchema>,
  today: string,
): Promise<boolean> {
  const existing = await getSampleCardId(db);
  if (existing !== null) {
    const [newest] = await getStatementsForCard(db, existing);
    if (newest?.statementDateISO === newestStatementDate(today)) return false;
    await remove(db);
  }
  const [first, ...rest] = sampleStatementFiles(today).map(
    ({ name, text }): ParseResult => ({
      fileName: name,
      parsed: parseStatementBytes(name, new TextEncoder().encode(text)),
    }),
  );

  const before = new Set(await db.getAllKeys('cards'));
  await importSample(db, [first], NEW_CARD, today);
  const created = (await db.getAllKeys('cards')).filter((k) => !before.has(k));
  if (created.length !== 1) {
    throw new Error(
      `loadSampleData: expected 1 new card, got ${created.length}`,
    );
  }
  // Recorded before the rest go in, so a failure while importing them
  // still leaves the card where a reset can find it.
  await putSetting(db, SETTING_KEY, created[0]);
  await importSample(db, rest, created[0], today);
  return true;
}

/** Plan and commit sample files onto one card (an id, or NEW_CARD). */
async function importSample(
  db: IDBPDatabase<KardabraSchema>,
  results: ParseResult[],
  assignment: string,
  today: string,
): Promise<void> {
  const outcomes = planImport(
    results,
    await db.getAll('cards'),
    await db.getAll('statements'),
    new Map(results.map(({ fileName }) => [fileName, assignment])),
  );
  const nicknames = new Map<string, string>();
  for (const outcome of outcomes) {
    if (outcome.kind !== 'new-statement') {
      throw new Error(`loadSampleData: unexpected outcome ${outcome.kind}`);
    }
    const key = cardInputKey(outcome.cardRef, outcome.parsed.fileName);
    nicknames.set(key, SAMPLE_NICKNAME);
  }
  await commitImport(db, outcomes, { nicknames, dueDays: new Map() }, today);
}

/** Delete the sample card and everything under it; real cards untouched. */
async function remove(db: IDBPDatabase<KardabraSchema>): Promise<void> {
  const id = await getSampleCardId(db);
  if (id !== null) await deleteCardCascade(db, id);
  await db.delete('settings', SETTING_KEY);
}
