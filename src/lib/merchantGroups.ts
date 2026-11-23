/**
 * One name per merchant, shared by Insights and the CSV export: the bank's
 * spellings grouped (`groupKeys`), then the user's renames on top.
 * Derived at read time; only the renames are stored (`merchantNames`).
 */

import { cleanMerchant, isBrand, merchantKey } from './merchant';

/** A key this long or longer can stand for the keys it starts; a shorter
 * one ("TATA") is too likely a shared first word. */
const MIN_STEM = 8;

/** A user's name for a merchant, stored under the key of the group it was
 * given to (that group's stem: see `groupKeys`). */
export interface MerchantRename {
  key: string;
  name: string;
}

/** One line's merchant. */
export interface NamedMerchant {
  /** The name shown: the user's, when the merchant was renamed. */
  merchant: string;
  /** Lines with the same key are one merchant. A rename's key comes from
   * its name, so two merchants given one name are one. */
  merchantKey: string;
  /** The bank's group this line is in: what a rename is stored under. */
  group: string;
  /** This line's own key, before grouping (a group's members). */
  bankKey: string;
  /** The group's name from the bank's spellings, as if never renamed. */
  bankName: string;
  renamed: boolean;
}

/**
 * Each merchant key mapped to its group's key: the shortest key in the data,
 * MIN_STEM characters or more, that it starts with. Banks print the name in
 * a fixed-width field, so variation lands at the end ("ORBGEN TECHNOLOGIES
 * PR", "TATA PAYMENTS LIMITEDBMUMBAI") while the start stays put. Known
 * brands are left out on both sides: the brand table already groups their
 * spellings, and a bare "RELIANCE" must not take Reliance Digital and
 * Reliance Trends together. Two keys of one name that share only a stem
 * nobody printed alone stay apart.
 */
function groupKeys(
  lines: readonly { clean: string; key: string }[],
  renamedKeys: readonly string[],
): Map<string, string> {
  const stems = new Set<string>();
  for (const { clean, key } of lines) {
    if (!isBrand(clean) && key.length >= MIN_STEM) stems.add(key);
  }
  // A renamed key is a stem even when these lines never print it: a rename
  // made over all cards must reach a card whose lines only extend it.
  for (const key of renamedKeys) if (key.length >= MIN_STEM) stems.add(key);
  const groups = new Map<string, string>();
  for (const key of stems) {
    let group = key;
    for (let len = MIN_STEM; len < key.length; len++) {
      if (stems.has(key.slice(0, len))) {
        group = key.slice(0, len);
        break;
      }
    }
    groups.set(key, group);
  }
  return groups;
}

/** The most common of these names; on a tie, the one with more spaces
 * (words read better than "TATAPAYMENTS"), then the first alphabetically. */
function mostCommon(counts: Map<string, number>): string {
  const spaces = (name: string) => name.split(' ').length;
  const [best] = [...counts].sort(
    (a, b) =>
      b[1] - a[1] || spaces(b[0]) - spaces(a[0]) || a[0].localeCompare(b[0]),
  );
  return best[0];
}

function tally(
  map: Map<string, Map<string, number>>,
  key: string,
  name: string,
) {
  const counts = map.get(key) ?? new Map<string, number>();
  counts.set(name, (counts.get(name) ?? 0) + 1);
  map.set(key, counts);
}

/**
 * The merchant of each payee, in order. A group is named by the most common
 * spelling of its shortest printed key (the least noise on its end). A
 * rename is looked up by the group's key, then by any key in the group: new
 * statements can bring a shorter stem, which moves the group's key but must
 * not lose the user's name for it.
 */
export function nameMerchants(
  payees: readonly string[],
  renames: readonly MerchantRename[] = [],
): NamedMerchant[] {
  const lines = payees.map((payee) => {
    const clean = cleanMerchant(payee);
    return { clean, key: merchantKey(clean) };
  });
  const renamed = new Map(renames.map((r) => [r.key, r.name]));
  const groupOf = groupKeys(lines, [...renamed.keys()]);
  const group = (key: string) => groupOf.get(key) ?? key;

  const spellings = new Map<string, Map<string, number>>();
  const members = new Map<string, Set<string>>();
  for (const { clean, key } of lines) {
    tally(spellings, key, clean);
    const g = group(key);
    members.set(g, (members.get(g) ?? new Set<string>()).add(key));
  }
  const bankNames = new Map(
    [...members].map(([g, keys]) => {
      const [shortest] = [...keys].sort(
        (a, b) => a.length - b.length || a.localeCompare(b),
      );
      return [g, mostCommon(spellings.get(shortest)!)];
    }),
  );

  const given = new Map<string, string>();
  for (const [g, keys] of members) {
    const name =
      renamed.get(g) ??
      [...keys]
        .sort()
        .map((key) => renamed.get(key))
        .find((n) => n !== undefined);
    if (name !== undefined) given.set(g, name);
  }

  // A renamed group takes its name's key; any line under that key, renamed
  // or not, is then named by the rename (the user's word wins).
  const finalKey = (g: string) => {
    const name = given.get(g);
    return name === undefined ? g : merchantKey(name);
  };
  const renamesByKey = new Map<string, Map<string, number>>();
  for (const { key } of lines) {
    const g = group(key);
    const name = given.get(g);
    if (name !== undefined) tally(renamesByKey, finalKey(g), name);
  }

  return lines.map(({ key }) => {
    const g = group(key);
    const k = finalKey(g);
    const bankName = bankNames.get(g)!;
    const rename = renamesByKey.get(k);
    return {
      merchant: rename === undefined ? bankName : mostCommon(rename),
      merchantKey: k,
      group: g,
      bankKey: key,
      bankName,
      renamed: given.has(g),
    };
  });
}
