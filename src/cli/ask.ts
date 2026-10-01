/**
 * `npm run ask <path>` — the capture flow (0002), framed by authorship (0003).
 *
 *   1. Whose commits are these? Asked once per identity, outside the budget.
 *   2. Detect, and store what surfaced.
 *   3. Ask about this week's few, best first. Store what comes back.
 *
 * `--manual` skips the detector. `--calibration` prints what the answers say
 * about the detector. The steps live in core/decisions/capture.ts, shared with
 * the web UI (0006); this file is terminal transport.
 */
import { parseArgs } from 'node:util';

import { markShown, nextCandidates, weeklyBudget } from '../core/decisions/budget.js';
import { calibration } from '../core/decisions/calibration.js';
import {
  answerCandidate,
  candidateCostContext,
  costContextFor,
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
import { identitySetup } from './identity-setup.js';
import { createPrompter, type Prompter } from './prompt.js';
import { openSession, SetupError, type Session } from '../session.js';

const USAGE = `
Usage: npm run ask <path-to-repo> [options]

  --manual             record a decision without the detector
    --sha <sha>        optional anchor commit for --manual
    --file <path>      optional anchor file for --manual
  --calibration        what your answers say about the detector (no path needed)
  --limit <n>          questions per rolling week (default 3)
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
      limit: { type: 'string', default: '3' },
      help: { type: 'boolean', default: false },
    },
  });

  const target = positionals[0];
  if (values.help === true || (target === undefined && values.calibration !== true)) {
    console.log(USAGE);
    return values.help === true ? 0 : 1;
  }
  const limit = Number.parseInt(values.limit ?? '3', 10);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`--limit must be a positive integer, got ${String(values.limit)}`);
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

    await identitySetup(session, repo, clone, prompt);
    await askThisWeek(session, repo, clone, prompt, limit);
    return 0;
  } finally {
    prompt.close();
    await session.end();
  }
}

// ---------------------------------------------------------------------------
// 2–3. Detect, store, ask
// ---------------------------------------------------------------------------

async function askThisWeek(
  session: Session,
  repo: Repo,
  clone: LocalClone,
  prompt: Prompter,
  limit: number,
): Promise<void> {
  await refreshCandidates(session.db, repo, clone, session.userId);

  const budget = await weeklyBudget(session.db, session.userId, { limit });
  const next = await nextCandidates(session.db, session.userId, { limit, repoId: clone.id });
  if (next.length === 0) {
    console.log(
      budget.remaining === 0
        ? `\n  That's this week's ${budget.limit} — ${budget.shownThisWeek} shown in the last seven days. More next week.\n`
        : `\n  Nothing to ask about in ${clone.name} right now.\n`,
    );
    return;
  }

  const repoCost = await costContextFor(repo);
  for (const [i, candidate] of next.entries()) {
    await markShown(session.db, candidate.id);
    const q = questionFor(candidate, budget.shownThisWeek + i + 1, budget.limit);

    console.log(`\n  ${q.headline}`);
    for (const line of q.details) console.log(`    ${line}`);
    console.log(`\n  ${q.prompt}`);
    for (const o of q.options) console.log(`    [${o.key}] ${o.label}`);
    const key = await prompt.choose('\n  > ', q.options.map((o) => o.key));
    if (key === null) return;

    const option = q.options.find((o) => o.key === key);
    if (option === undefined) continue;
    const done = await answer(session, clone, prompt, candidate, option.action, q.choice, repoCost);
    if (!done) return;
  }
  console.log('');
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
