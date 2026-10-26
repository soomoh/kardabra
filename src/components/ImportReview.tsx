import { useId, useRef, useState } from 'react';
import { NEW_CARD, type FileOutcome } from '../import/plan';
import type { CardRecord } from '../db/schema';
import type { CommitUserInput } from '../import/commit';
import { buildFeedbackReport, feedbackEntriesFor } from '../import/feedback';
import {
  cardQuestions,
  importCount,
  outcomeFileName,
  planIsComplete,
  questionOwners,
  reviewGroups,
  suggestedName,
  type ReviewGroup,
} from '../import/review';
import { formatDateLabel, isValidDueDay, periodAxisLabel } from '../lib/dates';
import { XIcon } from './icons';

interface ImportReviewProps {
  outcomes: FileOutcome[];
  inputs: CommitUserInput;
  /** Existing cards, for "Which card is this?". */
  cards: CardRecord[];
  /** File name → chosen card id or NEW_CARD. */
  assignments: ReadonlyMap<string, string>;
  committing: boolean;
  commitError?: string;
  /** Number-masked diagnostics of unreadable files, by file name. */
  diagnostics: Map<string, string>;
  onNickname: (key: string, value: string) => void;
  /** null when the box was emptied — "no answer yet", not day 0. */
  onDueDay: (key: string, value: number | null) => void;
  onAssign: (fileName: string, choice: string) => void;
  onRemove: (fileName: string) => void;
  onCancel: () => void;
  onCommit: () => void;
}

/** Above this many statements, card groups start collapsed (unless they
 * ask something) so a big batch reads as a handful of cards. */
const COLLAPSE_ABOVE = 8;

/** What will happen to each dropped file, grouped by card, and the few
 * answers the plan needs before anything is written. Nothing is saved
 * until Import is pressed — the page says so, and the button stays in view. */
function ImportReview({
  outcomes,
  inputs,
  cards,
  assignments,
  committing,
  commitError,
  diagnostics,
  onNickname,
  onDueDay,
  onAssign,
  onRemove,
  onCancel,
  onCommit,
}: ImportReviewProps) {
  const [showMissing, setShowMissing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const owners = questionOwners(outcomes);
  const { groups, unreadable } = reviewGroups(outcomes);
  const feedbackEntries = feedbackEntriesFor(outcomes, diagnostics);
  const count = importCount(outcomes);
  const questions = cardQuestions(outcomes, cards, assignments);
  const unansweredCards = [...questions.keys()].filter(
    (fileName) => !assignments.has(fileName),
  ).length;
  const complete = planIsComplete(outcomes, inputs) && unansweredCards === 0;
  const statementRows = groups.reduce((n, g) => n + g.outcomes.length, 0);

  function handleImport() {
    if (!complete) {
      // Keep the button usable and say what's missing, rather than a
      // silently disabled button.
      setShowMissing(true);
      requestAnimationFrame(() =>
        listRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    onCommit();
  }

  function downloadReport() {
    const blob = new Blob([buildFeedbackReport(feedbackEntries)], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'kardabra-unreadable-statements.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  // A due day is asked only once the file's card is known: choosing an
  // existing card can make the question go away.
  const missingCards = groups.filter(
    (g) =>
      !hasPendingCard(g, questions, assignments) &&
      g.outcomes.some(
        (o) =>
          o.kind === 'new-statement' &&
          owners.dueDay.has(o.parsed.fileName) &&
          !isValidDueDay(inputs.dueDays.get(g.key) ?? 0),
      ),
  ).length;

  return (
    <div className="review">
      <p className="muted">
        Nothing is saved until you press Import. Remove anything you don't want.
      </p>

      <div ref={listRef}>
        {groups.map((group) => (
          <CardGroup
            key={group.key}
            group={group}
            inputs={inputs}
            owners={owners}
            showMissing={showMissing}
            questions={questions}
            assignments={assignments}
            onAssign={onAssign}
            collapsed={statementRows > COLLAPSE_ABOVE}
            disabled={committing}
            onNickname={onNickname}
            onDueDay={onDueDay}
            onRemove={onRemove}
          />
        ))}
      </div>

      {unreadable.length > 0 && (
        <section className="review-group">
          <h2 className="review-group-title">
            Couldn't read{' '}
            {unreadable.length === 1 ? 'this file' : 'these files'}
          </h2>
          <ul className="plan-list">
            {unreadable.map((outcome) => (
              <li key={outcome.fileName} className="plan-row">
                <div className="plan-row-main">
                  <div className="plan-row-file">{outcome.fileName}</div>
                  <div className="plan-row-details">
                    {outcome.kind === 'rejected'
                      ? outcome.advice
                      : outcome.message}
                  </div>
                </div>
                <RemoveButton
                  fileName={outcome.fileName}
                  disabled={committing}
                  onRemove={onRemove}
                />
              </li>
            ))}
          </ul>
          {feedbackEntries.length > 0 && (
            <div className="report-offer">
              <p className="muted">
                A local report can help add support for{' '}
                {feedbackEntries.length === 1 ? 'this file' : 'these files'}. It
                captures the layout with numbers masked, stays on your device,
                and is yours to review before sharing.
              </p>
              <button onClick={downloadReport}>Download report</button>
            </div>
          )}
        </section>
      )}

      <div className="review-actions">
        {!committing && commitError !== undefined && (
          <p className="error-text" role="alert">
            Import failed: {commitError}
          </p>
        )}
        {showMissing && !complete && (
          <p className="error-text" role="alert">
            {missingText(unansweredCards, missingCards)}
          </p>
        )}
        <div className="review-buttons">
          <button onClick={onCancel} disabled={committing}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={count === 0 ? onCommit : handleImport}
            disabled={committing}
          >
            {committing
              ? 'Importing…'
              : count === 0
                ? 'Done'
                : `Import ${count === 1 ? '1 statement' : `${count} statements`}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One card's statements. Anything the card needs from the user sits in a
 * callout at the top, and forces the group open. */
function CardGroup({
  group,
  inputs,
  owners,
  showMissing,
  questions,
  assignments,
  onAssign,
  collapsed,
  disabled,
  onNickname,
  onDueDay,
  onRemove,
}: {
  group: ReviewGroup;
  inputs: CommitUserInput;
  owners: ReturnType<typeof questionOwners>;
  showMissing: boolean;
  questions: ReturnType<typeof cardQuestions>;
  assignments: ReadonlyMap<string, string>;
  onAssign: (fileName: string, choice: string) => void;
  collapsed: boolean;
  disabled: boolean;
  onNickname: (key: string, value: string) => void;
  onDueDay: (key: string, value: number | null) => void;
  onRemove: (fileName: string) => void;
}) {
  const { key, cardRef } = group;
  const first = group.outcomes[0];
  // Name and due day wait until the card is known: picking an existing
  // card makes both irrelevant.
  const pendingCard = hasPendingCard(group, questions, assignments);
  const asksName =
    !pendingCard &&
    group.outcomes.some(
      (o) => o.kind === 'new-statement' && owners.name.has(o.parsed.fileName),
    );
  const asksDueDay =
    !pendingCard &&
    group.outcomes.some(
      (o) => o.kind === 'new-statement' && owners.dueDay.has(o.parsed.fileName),
    );
  const suggestion = suggestedName(first);
  const typedName = inputs.nicknames.get(key)?.trim();
  const title = pendingCard
    ? 'Which card?'
    : cardRef.kind === 'existing'
      ? cardRef.nickname
      : typedName || suggestion || 'New card';
  const dueDay = inputs.dueDays.get(key);
  const dueHintId = useId();
  const dueDayInvalid =
    (dueDay !== undefined && !isValidDueDay(dueDay)) ||
    (showMissing && dueDay === undefined);

  const summary =
    group.toImport === 0
      ? 'Already imported'
      : `${group.toImport === 1 ? '1 statement' : `${group.toImport} statements`} to import`;

  return (
    <details
      className="review-group"
      open={!collapsed || asksDueDay || pendingCard}
    >
      <summary>
        <span className="review-group-title">{title}</span>
        <span className="muted">
          {cardRef.kind === 'new' && !pendingCard && title !== 'New card'
            ? 'New card · '
            : ''}
          {summary}
        </span>
      </summary>

      {/* The name is optional (blank takes the suggestion), so it's a plain
          field; only a required answer gets the attention callout. */}
      {asksName && (
        <label className="field group-field">
          Card name
          <input
            type="text"
            value={inputs.nicknames.get(key) ?? ''}
            onChange={(e) => onNickname(key, e.target.value)}
            placeholder={suggestion}
            disabled={disabled}
          />
          <span className="field-hint">
            Optional. Leave blank to use “{suggestion}”.
          </span>
        </label>
      )}
      {asksDueDay && (
        <div className="callout">
          <label className="field">
            Due day of the month
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              step={1}
              className="input-short"
              value={dueDay ?? ''}
              onChange={(e) =>
                onDueDay(
                  key,
                  e.target.value === '' ? null : Number(e.target.value),
                )
              }
              aria-invalid={dueDayInvalid}
              aria-describedby={dueHintId}
              disabled={disabled}
            />
            <span
              id={dueHintId}
              className={dueDayInvalid ? 'field-hint error-text' : 'field-hint'}
            >
              {dueDay !== undefined && !isValidDueDay(dueDay)
                ? 'Enter a day from 1 to 31.'
                : 'This statement doesn’t print a due date. Which day of the month is the bill due?'}
            </span>
          </label>
        </div>
      )}

      <ul className="plan-list">
        {group.outcomes.map((outcome) => {
          const fileName = outcomeFileName(outcome);
          const { month, year } = periodAxisLabel(outcome.period);
          const due = outcome.parsed.summary.paymentDueDateISO;
          return (
            <li
              key={fileName}
              className={
                importCount([outcome]) === 0 ? 'plan-row skipped' : 'plan-row'
              }
            >
              <div className="plan-row-main">
                <div className="plan-row-file">
                  {month} {year}
                </div>
                <div className="plan-row-details">
                  <span>{fileName}</span>
                  <span>{outcome.parsed.transactions.length} transactions</span>
                  {due !== undefined && <span>due {formatDateLabel(due)}</span>}
                  {outcome.kind === 'duplicate' && (
                    <span className="badge">{duplicateLabel(outcome)}</span>
                  )}
                </div>
              </div>
              <RemoveButton
                fileName={fileName}
                disabled={disabled}
                onRemove={onRemove}
              />
              {questions.has(fileName) && (
                <WhichCard
                  fileName={fileName}
                  last4={outcome.parsed.last4}
                  options={questions.get(fileName)!}
                  choice={assignments.get(fileName)}
                  showMissing={showMissing}
                  disabled={disabled}
                  onAssign={onAssign}
                />
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** "Which card is this?" for one file. A callout until answered (it must
 * be), then a plain field so the answer can still be changed. */
function WhichCard({
  fileName,
  last4,
  options,
  choice,
  showMissing,
  disabled,
  onAssign,
}: {
  fileName: string;
  last4: string | null;
  options: { cardId: string; nickname: string }[];
  choice: string | undefined;
  showMissing: boolean;
  disabled: boolean;
  onAssign: (fileName: string, choice: string) => void;
}) {
  const hintId = useId();
  return (
    <div
      className={choice === undefined ? 'row-question callout' : 'row-question'}
    >
      <label className="field">
        Which card is this?
        <select
          value={choice ?? ''}
          onChange={(e) => onAssign(fileName, e.target.value)}
          aria-invalid={showMissing && choice === undefined}
          aria-describedby={hintId}
          disabled={disabled}
        >
          <option value="" disabled>
            Choose a card…
          </option>
          {options.map((o) => (
            <option key={o.cardId} value={o.cardId}>
              {o.nickname}
            </option>
          ))}
          <option value={NEW_CARD}>A new card</option>
        </select>
        <span id={hintId} className="field-hint">
          {last4 === null
            ? 'This statement doesn’t show its card number.'
            : `Its card number ends in ${last4.replace(/X/gi, '')}, like more than one of your cards.`}
        </span>
      </label>
    </div>
  );
}

/** A file in this group still waits for "Which card is this?". */
function hasPendingCard(
  group: ReviewGroup,
  questions: ReturnType<typeof cardQuestions>,
  assignments: ReadonlyMap<string, string>,
): boolean {
  return group.outcomes.some((o) => {
    const fileName = outcomeFileName(o);
    return questions.has(fileName) && !assignments.has(fileName);
  });
}

/** What's still needed before Import can run, in one sentence. */
function missingText(cardsToChoose: number, dueDays: number): string {
  const parts: string[] = [];
  if (cardsToChoose > 0) {
    parts.push(
      `choose the card for ${cardsToChoose === 1 ? 'one statement' : `${cardsToChoose} statements`}`,
    );
  }
  if (dueDays > 0) {
    parts.push(
      `add the due day for ${dueDays === 1 ? 'one card' : `${dueDays} cards`}`,
    );
  }
  const sentence = parts.join(' and ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} to import.`;
}

/** Plain words for why a file won't be written (or will replace one). */
function duplicateLabel(
  outcome: Extract<FileOutcome, { kind: 'duplicate' }>,
): string {
  if (outcome.inBatch) return 'Same month as another file — skipped';
  if (outcome.supersedes) return 'Replaces the copy already here';
  return 'Already imported — skipped';
}

function RemoveButton({
  fileName,
  disabled,
  onRemove,
}: {
  fileName: string;
  disabled: boolean;
  onRemove: (fileName: string) => void;
}) {
  return (
    <button
      className="icon-button"
      aria-label={`Remove ${fileName}`}
      title="Remove from this import"
      onClick={() => onRemove(fileName)}
      disabled={disabled}
    >
      <XIcon />
    </button>
  );
}

export default ImportReview;
