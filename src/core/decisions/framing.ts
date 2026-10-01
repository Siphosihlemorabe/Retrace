/**
 * How the product talks about who made a change (0003 §4, G4, G5).
 *
 * One place for the wording, so "you chose" can only ever be said about the
 * builder's own commits, and agent findings are stated as facts about one
 * change — never as a tally about the person.
 */
import type { CommitAuthorship } from '../detect/authorship.js';
import type { StoredCandidate } from '../detect/candidate-row.js';
import type { Answer } from './capture.js';
import type { DecisionRole, DismissalReason } from './record.js';

export function describeAuthorship(by: CommitAuthorship, authorEmail: string): string {
  switch (by.authorship) {
    case 'builder':
      return 'made by you';
    case 'builder_with_agent':
      return `made by you, with ${by.actor ?? 'an agent'}`;
    case 'agent':
      return `made by your agent (${by.actor ?? 'unrecognised'})`;
    case 'template':
      return by.actor === null ? 'from the first commit' : `from the template ${by.actor}`;
    case 'automation':
      return `automated (${by.actor ?? 'bot'})`;
    case 'other_human':
      return `made by someone else (${authorEmail})`;
    case 'unknown':
      return `author not confirmed yet (${authorEmail})`;
  }
}

// ---------------------------------------------------------------------------
// The question itself (0002 §3, 0003 §4)
// ---------------------------------------------------------------------------

/** What an answer does, independent of the key that chose it. */
export type AnswerAction =
  | { kind: 'decision'; role: DecisionRole }
  | { kind: 'goal' }
  | { kind: 'dismiss'; reason: DismissalReason }
  | { kind: 'not_a_choice_or_trivia' }
  | { kind: 'skip' };

export interface AnswerOption {
  key: string;
  label: string;
  action: AnswerAction;
}

export interface Question {
  headline: string;
  details: string[];
  prompt: string;
  options: AnswerOption[];
  /** Prefilled "Choice" field — the detector already knows it. */
  choice: string;
}

const NOT_A_CHOICE: AnswerOption = {
  key: 'x',
  label: 'Not really a choice / nothing depends on it',
  action: { kind: 'not_a_choice_or_trivia' },
};
const SKIP: AnswerOption = { key: 's', label: 'Skip for now', action: { kind: 'skip' } };

const pkg = (key: string) => key.replace(/^npm:/, '');

export function subjectLine(c: StoredCandidate): string {
  if (c.kind === 'replacement' && c.signals.displaced !== null) {
    return `replaced  npm:${c.signals.displaced} → ${c.subjectKey}`;
  }
  return c.kind === 'removal' ? `removed   ${c.subjectKey}` : `chose     ${c.subjectKey}`;
}

/**
 * Frame a candidate by who made it. Only the builder's own commits get "why
 * did you choose"; an agent's change is asked about as something that is in
 * their code (G4). Never states a count of the agent's commits (G5).
 */
export function questionFor(c: StoredCandidate, position: number, total: number): Question {
  const name = pkg(c.subjectKey);
  const over = c.signals.displaced === null ? '' : ` over ${c.signals.displaced}`;
  const files = c.filesInCommit === null ? '' : ` · ${c.filesInCommit} file${c.filesInCommit === 1 ? '' : 's'}`;
  const where =
    c.commitIndex === null || c.commitCount === null ? [] : [`commit ${c.commitIndex} of ${c.commitCount}`];

  const details = [
    `${c.introducingSha.slice(0, 7)}  ${JSON.stringify(c.signals.commitSubject)} · ${describeAuthorship(c.authorship, c.authorEmail)}${files}`,
    ...where,
  ];
  const headline = `${position} of ${total} this week · ${subjectLine(c)}`;

  if (c.authorship.authorship === 'agent') {
    const thing = c.kind === 'replacement' ? 'This swap' : c.kind === 'removal' ? 'This removal' : 'This dependency';
    return {
      headline,
      details,
      prompt: `${thing} is in your code. What's the story?`,
      choice: c.kind === 'removal' ? `keep ${name} removed` : `keep ${name}${over}`,
      options: [
        { key: 'a', label: "I asked for it (or made it myself in the agent's editor)", action: { kind: 'decision', role: 'directed' } },
        { key: 'k', label: "I didn't ask, but I'd keep it — here's why", action: { kind: 'decision', role: 'kept' } },
        { key: 'g', label: "I didn't know this had changed", action: { kind: 'goal' } },
        NOT_A_CHOICE,
        SKIP,
      ],
    };
  }

  return {
    headline,
    details,
    prompt: 'What happened here?',
    choice: c.kind === 'removal' ? `drop ${name}` : `${name}${over}`,
    options: [
      { key: 'd', label: 'I chose this deliberately', action: { kind: 'decision', role: 'made' } },
      { key: 'g', label: "I didn't know that was a choice", action: { kind: 'goal' } },
      { key: 'n', label: "Not my choice (generated, inherited, someone else's)", action: { kind: 'dismiss', reason: 'not_my_choice' } },
      NOT_A_CHOICE,
      SKIP,
    ],
  };
}

/** A learning goal titled from what it is about, not just a package name. */
export function goalTitle(c: StoredCandidate): string {
  const name = pkg(c.subjectKey);
  if (c.kind === 'replacement' && c.signals.displaced !== null) {
    return `What changed when ${c.signals.displaced} was replaced by ${name}`;
  }
  return c.kind === 'removal' ? `Why ${name} was removed` : `What ${name} does here, and what it costs`;
}

/**
 * Whether an answer is one this question offered. The CLI can only send what
 * it showed; an API can be sent anything, so it checks — a `made` role on an
 * agent's change would be exactly the blur G4 forbids.
 */
export function isOffered(q: Question, answer: Answer): boolean {
  return q.options.some(({ action }) => {
    switch (answer.kind) {
      case 'skip':
        return action.kind === 'skip';
      case 'goal':
        return action.kind === 'goal';
      case 'decision':
        return action.kind === 'decision' && action.role === answer.role;
      case 'dismiss':
        return (
          (action.kind === 'dismiss' && action.reason === answer.reason) ||
          (action.kind === 'not_a_choice_or_trivia' &&
            (answer.reason === 'not_a_choice' || answer.reason === 'not_load_bearing'))
        );
    }
  });
}
