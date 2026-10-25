/**
 * The import review's decisions, kept out of the component so they're
 * testable: which file asks each question, whether every answer is in, and
 * what a blank card name means.
 */

import { isValidDueDay } from '../lib/dates';
import { cardInputKey, type FileOutcome } from './plan';
import type { CommitUserInput } from './commit';

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
