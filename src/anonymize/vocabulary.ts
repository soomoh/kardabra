/**
 * The only words the anonymizer keeps verbatim. Everything else that is made
 * of letters becomes a same-length pseudo-word, so a name, address or
 * merchant that nobody thought to list can't survive — the leak is
 * structurally impossible rather than merely unlikely.
 *
 * What belongs here: statement structure (column headers, summary labels,
 * Dr/Cr markers), the transaction keywords the parser and spend logic key on
 * (payment, refund, fee…), month names, currencies, bank and card-product
 * names (they identify a layout, not a person), and connective words that
 * appear in labels. What never belongs here: anything that could name a
 * person, place or merchant. A word that is both (e.g. "Swiggy" is a card
 * product and a merchant) stays out.
 */
const WORDS = `
  a an and any are as at be by for from if in is it not of on or per the this
  to up via with without you your yours
  account accounts acct addon add active adjusted adjustment address
  alert alerts allowed amount amt amounts annual applicable available
  balance bal base benefit benefits bill billed billing bonus branch
  card cardholder cards cash cashback category cgst charge charges cheque
  closing code conversion converted cr credit credited credits currency
  current customer
  date dated dates day days debit debited debits deposit deposits
  description desc details detail disbursed discount dr due dues
  earned emi end ending ends expiring
  fee fees finance financial first foreign fuel
  gst gstn grand greater
  holder
  igst imps inr installment insta instalment interest international
  last late legend legends level limit limits loan lapsed
  markup member membership merchant min minimum mode month monthly months
  name narration neft net new next no number
  offer office opening other others outstanding over overlimit
  page paid particulars past pay payable payment payments period
  points previous primary principal program programme programs
  purchase purchases
  rate received ref reference refund refunds registered remarks
  renewal retail reversal reversed reward rewards rs rupees
  s sgst sl sno sr spend spends state statement statements sub
  summary surcharge
  tax taxes thank than till time to total totals transaction transactions
  transfer txn txns type
  unbilled upi usd eur gbp aed sgd
  value view waiver waived withdrawal withdrawals
  year years
  autopay auto bbps bppy nach si atm pos ecom ecs rtgs cms chq dt int pd
  savings regular advance advances my zone selected ltd limited pvt private
  mr mrs ms smt shri
  domestic overseas
  jan january feb february mar march apr april may jun june jul july
  aug august sep sept september oct october nov november dec december
  hdfc icici axis sbi kotak amex american express idfc indusind yes rbl au
  hsbc standard chartered federal scapia onecard bobcard citi bank
  regalia infinia diners millennia moneyback coral rubyx sapphiro
  myzone ace magnus atlas select
`;

export const VOCABULARY: ReadonlySet<string> = new Set(
  WORDS.split(/\s+/).filter((w) => w.length > 0),
);

/** True when `word` (letters only) may be kept verbatim. Single letters are
 * kept: they carry Dr/Cr-style markers ("C"/"D") and at most an initial. */
export function isStructuralWord(word: string): boolean {
  return word.length === 1 || VOCABULARY.has(word.toLowerCase());
}
