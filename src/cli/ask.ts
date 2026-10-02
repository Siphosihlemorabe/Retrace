/**
 * `npm run ask <path>` — this week's questions (0002, 0009), framed by authorship (0003).
 *
 *   1. Whose commits are these? Asked once per identity, outside the budget.
 *   2. Detect dependency choices; scan new commits for code that touches goals.
 *   3. Ask this week's few, in the queue's order. Store what comes back.
 *
 * `--manual` skips the detector. `--calibration` prints what the answers say
 * about the detector. The steps live in core/decisions/capture.ts, shared with
 * the web UI (0006); this file is terminal transport.
 */
import { parseArgs } from 'node:util';

import { calibration } from '../core/decisions/calibration.js';
import {
  answerCandidate,
  candidateCostContext,
  costContextFor,
  loadCandidate,
  refreshCandidates,
  type Answer,
  type RepoCostContext,
} from '../core/decisions/capture.js';
import { checkCost, type CostContext, type CostVerdict } from '../core/decisions/cost-check.js';
import { questionFor, type AnswerAction } from '../core/decisions/framing.js';
import { registerLocalClone, type LocalClone } from '../core/decisions/local.js';
import { recordDecision, reviseDecision, type DecisionRole, type DecisionShape } from '../core/decisions/record.js';
import type { StoredCandidate } from '../core/detect/candidate-row.js';
import { GitError, openRepo, type Repo } from '../core/git/index.js';
import { providerFromEnv, type Provider } from '../core/llm/index.js';
import { scanNewCommits } from '../core/outcomes/scan.js';
import {
  allowModelForRepo,
  answerQuestion,
  closeCandidateQuestion,
  markQuestionShown,
  modelAllowed,
  nextQuestions,
  questionBudget,
  setQuestionsPerWeek,
  skipQuestion,
  MIN_PER_WEEK,
} from '../core/questions/queue.js';
import { questionCard, type QuestionCard } from '../core/questions/view.js';
import { identitySetup } from './identity-setup.js';
import { createPrompter, type Prompter } from './prompt.js';
import { openSession, SetupError, type Session } from '../session.js';

const USAGE = `
Usage: npm run ask <path-to-repo> [options]

  --manual             record a decision without the detector
    --sha <sha>        optional anchor commit for --manual
    --file <path>      optional anchor file for --manual
  --calibration        what your answers say about the detector (no path needed)
  --per-week <n>       questions per rolling week, kept for next time (at least 3)
`.trim();

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      manual: { type: 'boolean', default: false },
      calibration: { type: 'boolean', default: false },
      sha: { type: 'string' },
      file: { type: 'string' },
      'per-week': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  const target = positionals[0];
  if (values.help === true || (target === undefined && values.calibration !== true)) {
    console.log(USAGE);
    return values.help === true ? 0 : 1;
  }
  const perWeek = values['per-week'] === undefined ? null : Number(values['per-week']);
  if (perWeek !== null && (!Number.isInteger(perWeek) || perWeek < MIN_PER_WEEK)) {
    console.error(`--per-week must be a whole number, at least ${MIN_PER_WEEK}; got ${String(values['per-week'])}`);
    return 1;
  }

  const session = await openSession();
  const prompt = createPrompter();
  try {
    if (values.calibration === true) {
      await printCalibration(session);
      return 0;
    }
    const repo = await openRepo(target as string);
    const clone = await registerLocalClone(session.db, repo);

    if (values.manual === true) {
      const anchor = {
        ...(values.sha === undefined ? {} : { sha: values.sha }),
        ...(values.file === undefined ? {} : { path: values.file }),
      };
      await manualEntry(session, clone, prompt, anchor, await costContextFor(repo));
      return 0;
    }

    if (perWeek !== null) await setQuestionsPerWeek(session.db, session.userId, perWeek);
    await identitySetup(session, repo, clone, prompt);
    await askThisWeek(session, repo, clone, prompt);
    return 0;
  } finally {
    prompt.close();
    await session.end();
  }
}

// ---------------------------------------------------------------------------
// 2–3. Detect, store, ask
// ---------------------------------------------------------------------------

async function askThisWeek(session: Session, repo: Repo, clone: LocalClone, prompt: Prompter): Promise<void> {
  const { db, userId } = session;
  await refreshCandidates(db, repo, clone, userId);
  await scanNewCommits({ db, userId, repo, repoId: clone.id });

  let provider: Provider | null = null;
  try {
    provider = providerFromEnv();
  } catch (e) {
    console.log(`\n  ${(e as Error).message} Questions will be written without a model.`);
  }
  if (provider !== null && provider.sendsCodeOffMachine && !(await modelAllowed(db, clone.id))) {
    console.log(
      `\n  Questions about your code itself need a model to read it. With ${provider.name}, the lines a\n` +
        '  question is about leave this computer and go to Anthropic. Asked once for this project.',
    );
    const yes = await prompt.choose('  Allow it for this project? [y/N] ', ['y', 'n', '']);
    if (yes === null) return;
    if (yes === 'y') await allowModelForRepo(db, clone.id);
  }

  const list = await nextQuestions({ db, userId, repo, repoId: clone.id }, provider);
  if (list.length === 0) {
    const budget = await questionBudget(db, userId);
    console.log(
      budget.remaining === 0
        ? `\n  That's this week's ${budget.limit}: ${budget.shownThisWeek} shown in the last seven days. More next week.\n`
        : `\n  Nothing to ask about in ${clone.name} right now.\n`,
    );
    return;
  }

  const repoCost = await costContextFor(repo);
  for (const q of list) {
    const budget = await questionBudget(db, userId);
    await markQuestionShown(db, userId, q.id);
    const card = await questionCard(db, repo, q);
    const n = Math.min(budget.limit, budget.shownThisWeek + (q.shownAt === null ? 1 : 0));
    console.log(`\n  Question ${n} of ${budget.limit} this week`);

    if (card.kind === 'candidate' && q.candidateId !== null) {
      const candidate = await loadCandidate(db, userId, q.candidateId);
      if (candidate === null) continue;
      const done = await askDecision(session, clone, prompt, candidate, repoCost);
      await closeCandidateQuestion(db, userId, candidate.id);
      if (!done) return;
      continue;
    }
    if (!(await askOutcome(session, prompt, card))) return;
  }
  console.log('');
}

/** 0002's question about a dependency choice. False at end of input. */
async function askDecision(
  session: Session,
  clone: LocalClone,
  prompt: Prompter,
  candidate: StoredCandidate,
  repoCost: RepoCostContext,
): Promise<boolean> {
  const q = questionFor(candidate, 1, 1);
  console.log(`  ${q.headline.split(' · ').slice(1).join(' · ')}`);
  for (const line of q.details) console.log(`    ${line}`);
  console.log(`\n  ${q.prompt}`);
  for (const o of q.options) console.log(`    [${o.key}] ${o.label}`);
  const key = await prompt.choose('\n  > ', q.options.map((o) => o.key));
  if (key === null) return false;
  const option = q.options.find((o) => o.key === key);
  if (option === undefined) return true;
  return answer(session, clone, prompt, candidate, option.action, q.choice, repoCost);
}

const WHO: Record<string, string> = {
  builder: 'you',
  builder_with_agent: 'you, with an agent',
  agent: 'your agent',
  template: 'a template',
  automation: 'automation',
  other_human: 'someone else',
  unknown: 'an author not yet confirmed',
};

/** A question about code that touches a goal. The answer is practice: kept, never counted. */
async function askOutcome(session: Session, prompt: Prompter, card: QuestionCard): Promise<boolean> {
  if (card.outcome !== null) console.log(`  ${card.outcome.skill} · ${card.outcome.name}`);
  if (card.code !== null) {
    const [from, to] = card.code.lines;
    console.log(`  ${card.code.path}:${from}${to !== from ? `–${to}` : ''} · written by ${WHO[card.code.authorship] ?? card.code.authorship}\n`);
    const width = String(card.code.excerpt.at(-1)?.n ?? 0).length;
    for (const l of card.code.excerpt) {
      const mark = l.n >= from && l.n <= to ? '>' : ' ';
      console.log(`  ${mark} ${String(l.n).padStart(width)}  ${l.text}`);
    }
  }
  console.log(`\n  ${card.text}`);
  console.log(card.foundBy === 'model' ? `  (written by ${card.provider ?? 'the model'} after reading these lines)` : '  (written without a model reading the code)');
  const text = await prompt.text('\nYour answer, in your own words (enter to skip)\n ');
  if (text === null) {
    const status = await skipQuestion(session.db, session.userId, card.id);
    console.log(status === 'expired' ? '  Skipped three times. It won’t come up again.' : '  Skipped. It may come back.');
    return true;
  }
  await answerQuestion(session.db, session.userId, card.id, text);
  console.log('  Saved as practice. It doesn’t count toward learned; that takes a note on the code and a passed check.');
  return true;
}

/** Turns a chosen option into an Answer, prompting for whatever it needs. False at end of input. */
async function answer(
  session: Session,
  clone: LocalClone,
  prompt: Prompter,
  candidate: StoredCandidate,
  action: AnswerAction,
  choice: string,
  repoCost: RepoCostContext,
): Promise<boolean> {
  let given: Answer;
  switch (action.kind) {
    case 'skip':
      given = { kind: 'skip' };
      break;
    case 'dismiss':
      given = { kind: 'dismiss', reason: action.reason };
      break;
    case 'not_a_choice_or_trivia': {
      const which = await prompt.choose(
        '  Which?  [c] there was no real alternative   [l] nothing depends on it\n  > ',
        ['c', 'l'],
      );
      if (which === null) return false;
      given = { kind: 'dismiss', reason: which === 'c' ? 'not_a_choice' : 'not_load_bearing' };
      break;
    }
    case 'goal':
      // One follow-up, no more: admitting a gap must not cost more than
      // dismissing (0002 open question 2).
      given = { kind: 'goal', note: await prompt.text('What would you want to understand about it? (enter to skip)\n ') };
      break;
    case 'decision':
      given = { kind: 'decision', role: action.role, shape: await promptShape(prompt, choice) };
      break;
  }

  const cost = candidateCostContext(candidate, repoCost);
  const result = await answerCandidate(session.db, {
    userId: session.userId,
    repoId: clone.id,
    candidate,
    answer: given,
    cost,
  });

  switch (result.kind) {
    case 'skipped':
      console.log(result.status === 'expired' ? '  Skipped three times — it won’t come up again.' : '  Skipped. It may come back.');
      break;
    case 'dismissed':
      console.log('  Noted — that tells the detector it got this one wrong.');
      break;
    case 'goal':
      console.log(`  Learning goal: ${result.title}`);
      break;
    case 'decision':
      if (given.kind === 'decision') await offerRevisions(session, prompt, result.decisionId, given.shape, result.verdict, cost);
      break;
  }
  return true;
}

async function promptShape(prompt: Prompter, choice: string | null): Promise<DecisionShape> {
  console.log('');
  return {
    choice: await prompt.text('Choice', choice),
    context: await prompt.text('Context'),
    optionsConsidered: await prompt.text('Options'),
    cost: await prompt.text('Cost'),
    revisitCondition: await prompt.text('Revisit', null),
  };
}

/**
 * The teaching moment. Revisions go through decision_revisions, so a better
 * cost never silently replaces the first one.
 */
async function offerRevisions(
  session: Session,
  prompt: Prompter,
  decisionId: string,
  shape: DecisionShape,
  first: CostVerdict,
  cost: CostContext,
): Promise<void> {
  let verdict = first;
  printVerdict(verdict);
  while (!(verdict.namesLoss && verdict.systemSpecific)) {
    const again = await prompt.choose('  Revise cost? [y/N] ', ['y', 'n', '']);
    if (again !== 'y') break;
    shape.cost = await prompt.text('Cost', shape.cost);
    verdict = checkCost(shape.cost, cost);
    await reviseDecision(session.db, decisionId, shape, verdict);
    printVerdict(verdict);
  }
  console.log('  Saved.');
}

function printVerdict(v: CostVerdict): void {
  const mark = (ok: boolean) => (ok ? '✓' : '✗');
  console.log(`\n  Cost check: names a loss ${mark(v.namesLoss)} · specific to this system ${mark(v.systemSpecific)}`);
  for (const f of v.feedback) console.log(`    ${f}`);
}

// ---------------------------------------------------------------------------
// --manual and --calibration
// ---------------------------------------------------------------------------

async function manualEntry(
  session: Session,
  clone: LocalClone,
  prompt: Prompter,
  anchor: { sha?: string; path?: string },
  repoCost: RepoCostContext,
): Promise<void> {
  console.log('\n  A decision in your own words. Entered by hand, it stays a claim, not evidence.');
  const shape = await promptShape(prompt, null);
  const cost: CostContext = { ...repoCost, choice: shape.choice ?? 'this', alternative: null };
  const verdict = checkCost(shape.cost, cost);
  const id = await recordDecision(session.db, {
    userId: session.userId,
    repoId: clone.id,
    role: 'made' satisfies DecisionRole,
    shape,
    verdict,
    anchor,
  });
  await offerRevisions(session, prompt, id, shape, verdict, cost);
}

async function printCalibration(session: Session): Promise<void> {
  const c = await calibration(session.db, session.userId);
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

  console.log(`\n  Shown ${c.shown} · answered ${c.answered} · answer rate ${pct(c.answerRate)}`);
  console.log('  (Designed for one in five. With one builder this runs high; it means something with two.)\n');

  if (c.dismissals.length === 0) console.log('  No dismissals yet.');
  for (const d of c.dismissals) console.log(`  detector v${d.detectorVersion}  ${d.reason.padEnd(18)} ${d.n}`);

  const disputed = c.disputes.reduce((n, d) => n + d.n, 0);
  console.log(
    `\n  Agent-framed answers ${c.agentFramed} · "I asked for it" ${disputed}` +
      (c.agentFramed === 0 ? '' : ` (${pct(disputed / c.agentFramed)} — over a third means the agent label is wrong for these repos)`),
  );
  for (const d of c.disputes) console.log(`    authorship v${d.authorshipVersion}: ${d.n}`);
  if (c.byRole.length > 0) {
    console.log(`\n  Decisions by role: ${c.byRole.map((r) => `${r.role} ${r.n}`).join(' · ')}`);
  }
  console.log('');
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof SetupError || error instanceof GitError) console.error(error.message);
  else console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
