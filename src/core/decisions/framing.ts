/**
 * How the product talks about who made a change (0003 §4, G4, G5).
 *
 * One place for the wording, so "you chose" can only ever be said about the
 * builder's own commits, and agent findings are stated as facts about one
 * change — never as a tally about the person.
 */
import type { CommitAuthorship } from '../detect/authorship.js';

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
