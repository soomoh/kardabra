/**
 * The import review's decisions, kept out of the component so they're
 * testable: which file asks each question, whether every answer is in, and
 * what a blank card name means.
 */

import { isValidDueDay } from '../lib/dates';
import { cardInputKey, type FileOutcome } from './plan';
import type { CardRecord } from '../db/schema';
import type { CommitResult, CommitUserInput } from './commit';

/** An outcome's own file name, whichever variant it is ('new-statement'
 * keeps it inside `parsed`). */
export function outcomeFileName(outcome: FileOutcome): string {
  return outcome.kind === 'new-statement'
    ? outcome.parsed.fileName
    : outcome.fileName;
}

/** The suggested name for a new card, shown as the name box's placeholder. */
export function suggestedName(outcome: FileOutcome): string | undefined {
  return outcome.kind === 'new-statement' && outcome.cardRef.kind === 'new'
    ? outcome.cardRef.suggestedNickname
    : undefined;
}

/** Files that ask a question, by file name. Several files can share one new
 * card (planImport's batch dedupe, keyed by cardInputKey): only the first of
 * them shows the name box, and only the first that needs one shows the due
 * day box. */
export function questionOwners(outcomes: FileOutcome[]): {
  name: Set<string>;
  dueDay: Set<string>;
} {
  const name = new Set<string>();
  const dueDay = new Set<string>();
  const namedKeys = new Set<string>();
  const dueKeys = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.kind !== 'new-statement') continue;
    const key = cardInputKey(outcome.cardRef, outcome.parsed.fileName);
    if (outcome.cardRef.kind === 'new' && !namedKeys.has(key)) {
      namedKeys.add(key);
      name.add(outcome.parsed.fileName);
    }
    if (outcome.needsDueDay && !dueKeys.has(key)) {
      dueKeys.add(key);
      dueDay.add(outcome.parsed.fileName);
    }
  }
  return { name, dueDay };
}

/** Every due day the plan asks for has a valid answer. A card name may be
 * left blank: it takes the suggestion (withSuggestedNames). */
export function planIsComplete(
  outcomes: FileOutcome[],
  inputs: CommitUserInput,
): boolean {
  return outcomes.every((outcome) => {
    if (outcome.kind !== 'new-statement' || !outcome.needsDueDay) return true;
    const day = inputs.dueDays.get(
      cardInputKey(outcome.cardRef, outcome.parsed.fileName),
    );
    return day !== undefined && isValidDueDay(day);
  });
}

/** The answers with every blank card name replaced by its suggestion. */
export function withSuggestedNames(
  outcomes: FileOutcome[],
  inputs: CommitUserInput,
): CommitUserInput {
  const nicknames = new Map(inputs.nicknames);
  for (const outcome of outcomes) {
    const suggestion = suggestedName(outcome);
    if (outcome.kind !== 'new-statement' || suggestion === undefined) continue;
    const key = cardInputKey(outcome.cardRef, outcome.parsed.fileName);
    if ((nicknames.get(key) ?? '').trim() === '') {
      nicknames.set(key, suggestion);
    }
  }
  return { ...inputs, nicknames };
}

/** How many statements pressing Import will write: every new statement,
 * plus duplicates that replace a thinner stored copy. */
export function importCount(outcomes: FileOutcome[]): number {
  return outcomes.filter(
    (o) =>
      o.kind === 'new-statement' || (o.kind === 'duplicate' && o.supersedes),
  ).length;
}

type CardOutcome = Extract<
  FileOutcome,
  { kind: 'new-statement' | 'duplicate' }
>;

/** One card's files in the review: grouped so a big batch reads as a few
 * cards, not dozens of rows. `key` is the card's cardInputKey. */
export interface ReviewGroup {
  key: string;
  cardRef: CardOutcome['cardRef'];
  /** Newest period first. */
  outcomes: CardOutcome[];
  /** Statements in this group that Import will write. */
  toImport: number;
}

/** The review's layout: statements grouped by card (in order of first
 * appearance), and the files that couldn't be read. */
export function reviewGroups(outcomes: FileOutcome[]): {
  groups: ReviewGroup[];
  unreadable: Extract<FileOutcome, { kind: 'rejected' | 'failed' }>[];
} {
  const groups = new Map<string, ReviewGroup>();
  const unreadable: Extract<FileOutcome, { kind: 'rejected' | 'failed' }>[] =
    [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'rejected' || outcome.kind === 'failed') {
      unreadable.push(outcome);
      continue;
    }
    const key = cardInputKey(outcome.cardRef, outcomeFileName(outcome));
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, cardRef: outcome.cardRef, outcomes: [], toImport: 0 };
      groups.set(key, group);
    }
    group.outcomes.push(outcome);
    group.toImport += importCount([outcome]);
  }
  for (const group of groups.values()) {
    group.outcomes.sort((a, b) => b.period.localeCompare(a.period));
  }
  return { groups: [...groups.values()], unreadable };
}

/** The dashboard's confirmation after an import, in plain words.
 * `statementsWritten` already includes replaced copies. */
export function importedNotice(result: CommitResult): string {
  const { statementsWritten, cardsCreated } = result;
  if (statementsWritten === 0) {
    return 'Nothing new — those statements were already here.';
  }
  const statements =
    statementsWritten === 1 ? '1 statement' : `${statementsWritten} statements`;
  const cards =
    cardsCreated === 0
      ? ''
      : cardsCreated === 1
        ? ', 1 new card'
        : `, ${cardsCreated} new cards`;
  return `Imported ${statements}${cards}.`;
}

/** "Which card is this?" — asked per file when no confident match exists:
 * the statement's card number couldn't be read (and cards already exist),
 * or its last digits match more than one card (SBI prints only two). A
 * re-import recognised by its contents is confident, so it isn't asked.
 * Once answered, the question stays so the answer can be changed.
 * Returns file name → the cards to choose from (plus "a new card"). */
export function cardQuestions(
  outcomes: FileOutcome[],
  existingCards: Pick<CardRecord, 'id' | 'nickname' | 'last4'>[],
  assignments: ReadonlyMap<string, string>,
): Map<string, { cardId: string; nickname: string }[]> {
  const questions = new Map<string, { cardId: string; nickname: string }[]>();
  if (existingCards.length === 0) return questions;
  const option = (card: Pick<CardRecord, 'id' | 'nickname'>) => ({
    cardId: card.id,
    nickname: card.nickname,
  });
  for (const outcome of outcomes) {
    if (outcome.kind !== 'new-statement' && outcome.kind !== 'duplicate') {
      continue;
    }
    const fileName = outcomeFileName(outcome);
    const { last4 } = outcome.parsed;
    const matches =
      last4 === null ? [] : existingCards.filter((c) => c.last4 === last4);
    const unreadable = last4 === null && outcome.kind === 'new-statement';
    if (matches.length >= 2) {
      questions.set(fileName, matches.map(option));
    } else if (unreadable || assignments.has(fileName)) {
      questions.set(fileName, existingCards.map(option));
    }
  }
  return questions;
}
