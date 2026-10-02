/**
 * Turning a target into a question (0009): the model reading the actual code
 * when it may, a rule-based question when it may not — no model, no consent
 * for this repo, the daily cap reached, or a reply that didn't fit. Every
 * question records which it was.
 */
import { describeAuthorship, questionFor } from '../decisions/framing.js';
import type { StoredCandidate } from '../detect/candidate-row.js';
import type { Authorship } from '../detect/authorship.js';
import { filesAt, grepLines, headSha, type Repo } from '../git/index.js';
import { completeJson, providerFromEnv, type Provider } from '../llm/index.js';
import type { Db } from '../../db/types.js';
import { excerptAt, type Excerpt } from './excerpt.js';
import { QUESTION_PROMPT_VERSION, QUESTION_SYSTEM, QuestionOutput, UNTOUCHED_SYSTEM } from './prompt.js';

export type Target =
  | {
      kind: 'outcome_sighting';
      sightingId: string;
      outcomeId: string;
      outcome: { name: string; description: string; skill: string };
      sha: string;
      path: string;
      lineStart: number;
      lineEnd: number;
      authorship: Authorship;
      inObjective: boolean;
    }
  | { kind: 'outcome_untouched'; outcomeId: string; outcome: { name: string; description: string; skill: string } }
  | { kind: 'candidate'; candidate: StoredCandidate };

export interface Generated {
  text: string;
  keyPoints: { point: string; lines: [number, number] }[] | null;
  lines: [number, number] | null;
  foundBy: 'model' | 'rule';
  provider: string | null;
  model: string | null;
  cacheKey: string | null;
  /** Why the rule-based question was used, when it was. */
  fallbackReason: 'off' | 'capped' | 'failed' | 'no_consent' | null;
}

export interface GenerateScope {
  db: Db;
  userId: string;
  repo: Repo;
  repoId: string;
  /** Whether the builder agreed this repo's code may go to an off-machine model. */
  llmAllowed: boolean;
}

const WHO: Record<Authorship, string> = {
  builder: 'the developer',
  builder_with_agent: 'the developer, with an AI co-author',
  agent: 'their AI agent',
  template: 'a project template',
  automation: 'an automated bot',
  other_human: 'someone else on the project',
  unknown: 'an author not yet confirmed',
};

// ---------------------------------------------------------------------------
// Rule-based questions: specific about *where*, general about *why*.
// ---------------------------------------------------------------------------

const linesOf = (a: number, b: number) => (a === b ? `line ${a}` : `lines ${a}–${b}`);

export function ruleQuestion(target: Target): string {
  switch (target.kind) {
    case 'outcome_sighting': {
      const who = target.authorship === 'agent' ? 'Your agent wrote' : target.authorship === 'builder' || target.authorship === 'builder_with_agent' ? 'You wrote' : 'There is';
      return `${who} ${target.outcome.name.toLowerCase()} code in ${target.path}, ${linesOf(target.lineStart, target.lineEnd)}. What happens there when the data is not what the code expects, and what does this way of writing it cost compared with the alternatives?`;
    }
    case 'outcome_untouched':
      return `Your objective for this project includes ${target.outcome.name} (${target.outcome.description}), and nothing in the code touches it yet. Where in this project would it matter most, and what would adding it cost?`;
    case 'candidate':
      return questionFor(target.candidate, 1, 1).prompt;
  }
}

const fallback = (target: Target, reason: Generated['fallbackReason']): Generated => ({
  text: ruleQuestion(target),
  keyPoints: null,
  lines: target.kind === 'outcome_sighting' ? [target.lineStart, target.lineEnd] : null,
  foundBy: 'rule',
  provider: null,
  model: null,
  cacheKey: null,
  fallbackReason: reason,
});

// ---------------------------------------------------------------------------

/** Model lines must sit inside what the model was shown; otherwise the question points at code it never saw. */
const within = (lines: [number, number], ex: Excerpt) => lines[0] >= ex.from && lines[1] <= ex.to && lines[0] <= lines[1];

/** "line 7", "lines 54–55", "lines 66 and 75": every line range a question's text names. */
export function linesNamed(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/\blines?\s+(\d+)(?:\s*(?:–|—|-|to|and|through)\s*(\d+))?/gi)) {
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    out.push([Math.min(a, b), Math.max(a, b)]);
  }
  return out;
}

/**
 * The text must not name lines beyond what the question and its key points are
 * about. Found in the ten-question check: "lines 323–329" for an index on 324.
 */
function textMatchesLines(text: string, lines: [number, number], keyPoints: readonly { lines: [number, number] }[]): boolean {
  const all = [lines, ...keyPoints.map((k) => k.lines)];
  const from = Math.min(...all.map((l) => l[0]));
  const to = Math.max(...all.map((l) => l[1]));
  return linesNamed(text).every(([a, b]) => a >= from && b <= to);
}

export async function generate(scope: GenerateScope, target: Target, provider: Provider | null = providerFromEnv()): Promise<Generated> {
  if (provider === null) return fallback(target, 'off');
  if (provider.sendsCodeOffMachine && !scope.llmAllowed) return fallback(target, 'no_consent');

  const { db, userId, repo, repoId } = scope;
  let system = QUESTION_SYSTEM;
  let input: string;
  let cacheParts: (string | number)[];
  let excerpt: Excerpt | null = null;
  let sha: string | undefined;

  switch (target.kind) {
    case 'outcome_sighting': {
      excerpt = await excerptAt(repo, target.sha, target.path, target.lineStart, target.lineEnd);
      if (excerpt === null) return fallback(target, 'failed');
      sha = target.sha;
      input = [
        `Skill: ${target.outcome.skill}`,
        `Learning outcome: ${target.outcome.name} — ${target.outcome.description}`,
        `Written by: ${WHO[target.authorship]}`,
        `File: ${target.path} (lines ${target.lineStart}–${target.lineEnd} touch the outcome)`,
        '',
        excerpt.text,
      ].join('\n');
      cacheParts = [repoId, target.sha, target.path, target.lineStart, target.lineEnd, target.outcomeId];
      break;
    }
    case 'outcome_untouched': {
      system = UNTOUCHED_SYSTEM;
      sha = await headSha(repo);
      const paths = (await filesAt(repo, sha)).filter((p) => !/(^|\/)(node_modules|dist|\.git)\//.test(p)).slice(0, 300);
      input = [
        `Skill: ${target.outcome.skill}`,
        `Learning outcome: ${target.outcome.name} — ${target.outcome.description}`,
        '',
        'Project files:',
        ...paths,
      ].join('\n');
      cacheParts = [repoId, sha, 'untouched', target.outcomeId];
      break;
    }
    case 'candidate': {
      const c = target.candidate;
      const usages = await grepLines(repo, `['"]${c.signals.packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"/]`, 3);
      const snippets: string[] = [];
      for (const u of usages) {
        const ex = await excerptAt(repo, 'HEAD', u.path, u.line, u.line);
        if (ex !== null) snippets.push(`--- ${u.path}\n${ex.lines.slice(0, 25).map((l) => `${l.n}  ${l.text}`).join('\n')}`);
      }
      sha = c.introducingSha;
      input = [
        `A dependency choice in this project: ${c.kind === 'replacement' && c.signals.displaced !== null ? `${c.signals.displaced} was replaced by ${c.signals.packageName}` : `${c.signals.packageName} was ${c.kind === 'removal' ? 'removed' : 'added'}`}.`,
        `Made by: ${describeAuthorship(c.authorship, c.authorEmail)}, in a commit of ${c.filesInCommit ?? '?'} files.`,
        '',
        snippets.length > 0 ? 'Where it is used now:' : 'It is not imported anywhere at HEAD.',
        ...snippets,
      ].join('\n');
      cacheParts = [repoId, c.introducingSha, c.subjectKey];
      break;
    }
  }

  const result = await completeJson(
    db,
    userId,
    { purpose: `question:${target.kind}`, promptVersion: QUESTION_PROMPT_VERSION, system, input, schema: QuestionOutput, cacheParts, repoId, ...(sha === undefined ? {} : { sha }) },
    provider,
  );
  if (!result.ok) return fallback(target, result.reason);

  const q = result.value.questions[0];
  if (q === undefined) return fallback(target, 'failed');
  if (
    excerpt !== null &&
    (!within(q.lines, excerpt) || q.keyPoints.some((k) => !within(k.lines, excerpt)) || !textMatchesLines(q.text, q.lines, q.keyPoints))
  ) {
    // A line the model was never shown: the question can't be trusted.
    return fallback(target, 'failed');
  }
  return {
    text: q.text,
    keyPoints: q.keyPoints,
    lines: target.kind === 'outcome_sighting' ? q.lines : null,
    foundBy: 'model',
    provider: result.provider,
    model: result.model,
    cacheKey: result.cacheKey,
    fallbackReason: null,
  };
}
