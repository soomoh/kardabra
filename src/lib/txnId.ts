/**
 * Stable, content-derived transaction ids, so the same purchase gets the same
 * id every time its statement is (re-)imported — on this device or another.
 * The CSV export relies on this for de-duplication.
 *
 * Built from what the statement itself says: card key (last-4, or the card's
 * own id when no last-4 exists), date, amount, payee, plus an occurrence index
 * so two identical rows (two ₹120 coffees on the same day) stay distinct.
 * Not a security hash — FNV-1a 64-bit is enough to avoid collisions here, and
 * it is synchronous, which the IndexedDB upgrade that backfills ids needs
 * (an `await` on WebCrypto would let that transaction auto-commit).
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

interface IdInput {
  dateISO: string;
  amount: number;
  payee: string;
}

/** Ids for one statement's transactions, in the order given. */
export function transactionIds(cardKey: string, txns: IdInput[]): string[] {
  const seen = new Map<string, number>();
  return txns.map((t) => {
    const base = `${cardKey}|${t.dateISO}|${t.amount.toFixed(2)}|${t.payee.trim().toUpperCase()}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return 't' + fnv1a64(`${base}|${occurrence}`);
  });
}

/** The key a card contributes to its transactions' ids. */
export function cardIdKey(card: { id: string; last4: string | null }): string {
  return card.last4 ?? card.id;
}

/** Fingerprint of a statement's transaction list, independent of which card
 * it is attached to — the same file re-imported has the same fingerprint, so
 * a statement with no card number can still be recognised as already there. */
export function statementFingerprint(txns: IdInput[]): string {
  return fnv1a64(transactionIds('', txns).join(','));
}
