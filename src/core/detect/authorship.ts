/**
 * Who made a change (0003).
 *
 * Test 3 — "they actually chose it" — used to ask only whether *someone* chose
 * a change deliberately. In the test corpus five of the six surfaced candidates
 * were committed by the builder's AI agent, so it now also asks *who*. The
 * answer decides how a question is framed: nobody is asked to defend an agent's
 * choice as if it were their own (G4).
 *
 * Pure. Reads commit metadata the caller already has; no git, no database.
 */
import type { CommitMeta } from '../git/index.js';

/**
 * Bump when a rule or a catalogue entry changes what a commit is classified
 * as. Stored on every candidate, so old judgements stay readable as what they
 * were (G13).
 */
export const AUTHORSHIP_VERSION = 1;

/** Named to match `candidates_introduced_by` in the schema — one vocabulary. */
export const AUTHORSHIP_CLASSES = [
  'builder',
  'builder_with_agent',
  'agent',
  'template',
  'automation',
  'other_human',
  'unknown',
] as const;
export type Authorship = (typeof AUTHORSHIP_CLASSES)[number];

interface KnownIdentity {
  /** What the CLI calls it. */
  label: string;
  /** Matched against the lower-cased author name or email. */
  match: (name: string, email: string) => boolean;
}

// ---------------------------------------------------------------------------
// Catalogues. Seeded from identities actually seen in the corpus, and grown
// only from observation — like 0001's package catalogue, and for the same
// reason: a guessed identity is a wrong classification nobody notices.
// ---------------------------------------------------------------------------

/** AI agents that commit under their own identity. */
export const AGENTS: readonly KnownIdentity[] = [
  {
    // 702 commits across frontend-fixer, Siphosihle and fixit-landing-page.
    label: 'Lovable',
    match: (name, email) =>
      name === 'gpt-engineer-app[bot]' || email.includes('+gpt-engineer-app[bot]@'),
  },
];

/**
 * Agents that appear as a co-author trailer on a human's commit. ~90 such
 * trailers in confetti-confectionery, plus this repo's own commits.
 */
export const TRAILER_AGENTS: readonly KnownIdentity[] = [
  { label: 'Claude', match: (_name, email) => email === 'noreply@anthropic.com' },
];

/**
 * Bots that make changes nobody decided — a version bump is not a choice.
 * Kept apart from AGENTS on purpose: lumping them together would bury the
 * agent's silent decisions under routine updates.
 *
 * Not from the corpus (nothing in it uses them); included because 0003 names
 * them and their identities are fixed by GitHub, so this is not a guess.
 */
export const AUTOMATION: readonly KnownIdentity[] = [
  { label: 'Dependabot', match: (name) => name === 'dependabot[bot]' },
  { label: 'Renovate', match: (name) => name === 'renovate[bot]' },
];

/** Root commits written by an app builder: `template: vite_react_shadcn_ts_2026-04-20`. */
const TEMPLATE_SUBJECT = /^template:\s*(\S+)/i;

const CO_AUTHOR_TRAILER = /^co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/gim;

// ---------------------------------------------------------------------------

export interface IdentitySet {
  /** Emails the builder has confirmed are theirs. Lower-cased. */
  mine: ReadonlySet<string>;
  /** Emails the builder has said are someone else's. Lower-cased. */
  others: ReadonlySet<string>;
}

export interface CommitAuthorship {
  authorship: Authorship;
  /** Which rule decided it, so `--all` and calibration can say *why*. */
  rule: string;
  /** The agent, template or bot involved, when there is one. */
  actor: string | null;
}

export interface CoAuthor {
  name: string;
  email: string;
}

export function coAuthors(body: string): CoAuthor[] {
  return [...body.matchAll(CO_AUTHOR_TRAILER)].map((m) => ({
    name: m[1] ?? '',
    email: (m[2] ?? '').trim().toLowerCase(),
  }));
}

/** Whether an identity is one the catalogues already explain. */
export function knownNonHuman(name: string, email: string): string | null {
  const n = name.trim().toLowerCase();
  const e = email.trim().toLowerCase();
  for (const entry of [...AGENTS, ...AUTOMATION]) {
    if (entry.match(n, e)) return entry.label;
  }
  return null;
}

/**
 * First matching rule wins, in the order of 0003's table. `isRoot` comes from
 * the caller because "root" is a fact about the repo, not the commit.
 */
export function classifyCommit(
  meta: Pick<CommitMeta, 'authorName' | 'authorEmail' | 'subject' | 'body'>,
  isRoot: boolean,
  identities: IdentitySet,
): CommitAuthorship {
  const name = meta.authorName.trim().toLowerCase();
  const email = meta.authorEmail.trim().toLowerCase();

  const template = TEMPLATE_SUBJECT.exec(meta.subject);
  if (template !== null) {
    return { authorship: 'template', rule: 'template subject', actor: template[1] ?? null };
  }
  if (isRoot) {
    return { authorship: 'template', rule: 'root commit', actor: null };
  }

  for (const bot of AUTOMATION) {
    if (bot.match(name, email)) {
      return { authorship: 'automation', rule: 'known automation', actor: bot.label };
    }
  }
  for (const agent of AGENTS) {
    if (agent.match(name, email)) {
      return { authorship: 'agent', rule: 'known agent', actor: agent.label };
    }
  }

  if (identities.mine.has(email)) {
    const trailer = coAuthors(meta.body)
      .map((c) => TRAILER_AGENTS.find((a) => a.match(c.name.toLowerCase(), c.email)))
      .find((a) => a !== undefined);
    if (trailer !== undefined) {
      return {
        authorship: 'builder_with_agent',
        rule: 'your commit, agent co-author trailer',
        actor: trailer.label,
      };
    }
    return { authorship: 'builder', rule: 'your identity', actor: null };
  }

  if (identities.others.has(email)) {
    return { authorship: 'other_human', rule: 'identity you said is not you', actor: null };
  }

  // Includes unrecognised `[bot]` identities: asking once beats guessing.
  return { authorship: 'unknown', rule: 'identity not confirmed yet', actor: null };
}
