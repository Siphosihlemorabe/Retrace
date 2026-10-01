/**
 * `npm run ask <path>` — the capture flow (0002), framed by authorship (0003).
 *
 *   1. Whose commits are these? Asked once per identity, outside the budget.
 *   2. Detect, and store what surfaced.
 *   3. Ask about this week's few, best first. Store what comes back.
 *
 * `--manual` skips the detector. `--calibration` prints what the answers say
 * about the detector. All logic worth testing lives in core/; this file is
 * transport.
 */
import { parseArgs } from 'node:util';

import { weeklyBudget, markShown, nextCandidates, skipCandidate } from '../core/decisions/budget.js';
import { calibration } from '../core/decisions/calibration.js';
import { persistCandidates } from '../core/decisions/candidates.js';
import { checkCost, type CostContext, type CostVerdict } from '../core/decisions/cost-check.js';
import { goalTitle, questionFor, type AnswerAction } from '../core/decisions/framing.js';
import { loadIdentitySet, recordIdentity, unresolvedIdentities } from '../core/decisions/identity.js';
import { registerLocalClone, type LocalClone } from '../core/decisions/local.js';
import {
  dismissCandidate,
  recordDecision,
  recordLearningGoal,
  reviseDecision,
  type DecisionRole,
  type DecisionShape,
} from '../core/decisions/record.js';
import type { StoredCandidate } from '../core/detect/candidate-row.js';
import { detectDependencyDecisions } from '../core/detect/dependency.js';
import { parseManifest } from '../core/detect/manifest.js';
import { rank } from '../core/detect/rank.js';
import { authorIdentities, GitError, openRepo, showFile, trackedFiles, type Repo } from '../core/git/index.js';
import { createPrompter, type Prompter } from './prompt.js';
import { openSession, SetupError, type Session } from './session.js';

const USAGE = `
Usage: npm run ask <path-to-repo> [options]

  --manual             record a decision without the detector
    --sha <sha>        optional anchor commit for --manual
    --file <path>      optional anchor file for --manual
  --calibration        what your answers say about the detector (no path needed)
  --limit <n>          questions per rolling week (default 3)
`.trim();

const MANIFEST = 'package.json';

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
// 1. Identities (0003 §2) — setup, not budgeted
// ---------------------------------------------------------------------------

async function identitySetup(session: Session, repo: Repo, clone: LocalClone, prompt: Prompter): Promise<void> {
  const known = await loadIdentitySet(session.db, session.userId);
  const unresolved = unresolvedIdentities(await authorIdentities(repo), known);
  if (unresolved.length === 0) return;

  console.log('\n  First, whose commits are these? Asked once per identity.\n');
  for (const identity of unresolved) {
    const answer = await prompt.choose(
      `  Who is ${JSON.stringify(identity.name)} <${identity.email}>?   ${identity.commits} commit${identity.commits === 1 ? '' : 's'} in ${clone.name}\n` +
        '    [m] Me   [o] Someone else   [l] Ask me later\n  > ',
      ['m', 'o', 'l'],
    );
    if (answer === null) return;
    if (answer === 'l') continue;
    await recordIdentity(session.db, session.userId, identity, answer === 'm' ? 'me' : 'other');
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
  const identities = await loadIdentitySet(session.db, session.userId);
  const detected = await detectDependencyDecisions(repo, { manifestPath: MANIFEST, identities });
  const ranked = rank(detected.candidates);
  await persistCandidates(session.db, ranked.ranked, {
    repoId: clone.id,
    userId: session.userId,
    manifestPath: MANIFEST,
  });

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

  const costCtx = await costContextFor(repo);
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
    const done = await answer(session, clone, prompt, candidate, option.action, q.choice, costCtx);
    if (!done) return;
  }
  console.log('');
}

/** Returns false when input ended mid-answer. */
async function answer(
  session: Session,
  clone: LocalClone,
  prompt: Prompter,
  candidate: StoredCandidate,
  action: AnswerAction,
  choice: string,
  costCtx: Omit<CostContext, 'choice' | 'alternative'>,
): Promise<boolean> {
  switch (action.kind) {
    case 'skip': {
      const status = await skipCandidate(session.db, candidate.id);
      console.log(status === 'expired' ? '  Skipped three times — it won’t come up again.' : '  Skipped. It may come back.');
      return true;
    }
    case 'dismiss':
      await dismissCandidate(session.db, candidate.id, action.reason, null);
      console.log('  Noted — that tells the detector it got this one wrong.');
      return true;
    case 'not_a_choice_or_trivia': {
      const which = await prompt.choose(
        '  Which?  [c] there was no real alternative   [l] nothing depends on it\n  > ',
        ['c', 'l'],
      );
      if (which === null) return false;
      await dismissCandidate(session.db, candidate.id, which === 'c' ? 'not_a_choice' : 'not_load_bearing', null);
      console.log('  Noted.');
      return true;
    }
    case 'goal': {
      // One follow-up, no more: admitting a gap must not cost more than
      // dismissing (0002 open question 2).
      const note = await prompt.text('What would you want to understand about it? (enter to skip)\n ');
      await recordLearningGoal(session.db, {
        userId: session.userId,
        candidate,
        title: goalTitle(candidate),
        note,
      });
      console.log(`  Learning goal: ${goalTitle(candidate)}`);
      return true;
    }
    case 'decision': {
      const ctx: CostContext = {
        ...costCtx,
        choice: candidate.signals.packageName,
        alternative: candidate.signals.displaced,
      };
      await captureDecision(session, clone, prompt, action.role, choice, ctx, candidate);
      return true;
    }
  }
}

async function captureDecision(
  session: Session,
  clone: LocalClone,
  prompt: Prompter,
  role: DecisionRole,
  choice: string | null,
  costCtx: CostContext,
  candidate?: StoredCandidate,
  anchor?: { sha?: string; path?: string },
): Promise<void> {
  console.log('');
  const shape: DecisionShape = {
    choice: await prompt.text('Choice', choice),
    context: await prompt.text('Context'),
    optionsConsidered: await prompt.text('Options'),
    cost: await prompt.text('Cost'),
    revisitCondition: await prompt.text('Revisit', null),
  };

  // Manual entry learns what was chosen from the answer itself.
  if (costCtx.choice === '') costCtx = { ...costCtx, choice: shape.choice ?? 'this' };
  let verdict = checkCost(shape.cost, costCtx);
  const id = await recordDecision(session.db, {
    userId: session.userId,
    repoId: clone.id,
    role,
    shape,
    verdict,
    ...(candidate === undefined ? {} : { candidate }),
    ...(anchor === undefined ? {} : { anchor }),
  });
  printVerdict(verdict);

  // The teaching moment. Revisions go through decision_revisions, so a better
  // cost never silently replaces the first one.
  while (!(verdict.namesLoss && verdict.systemSpecific)) {
    const again = await prompt.choose('  Revise cost? [y/N] ', ['y', 'n', '']);
    if (again !== 'y') break;
    shape.cost = await prompt.text('Cost', shape.cost);
    verdict = checkCost(shape.cost, costCtx);
    await reviseDecision(session.db, id, shape, verdict);
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
  costCtx: Omit<CostContext, 'choice' | 'alternative'>,
): Promise<void> {
  console.log('\n  A decision in your own words. Entered by hand, it stays a claim, not evidence.');
  // No choice is known yet: captureDecision takes it from the first answer.
  await captureDecision(
    session,
    clone,
    prompt,
    'made',
    null,
    { ...costCtx, choice: '', alternative: null },
    undefined,
    anchor,
  );
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

async function costContextFor(repo: Repo): Promise<Omit<CostContext, 'choice' | 'alternative'>> {
  const [manifestSource, paths] = await Promise.all([showFile(repo, 'HEAD', MANIFEST), trackedFiles(repo)]);
  const manifest = parseManifest(manifestSource);
  return { packageNames: manifest === null ? [] : [...manifest.keys()], paths };
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof SetupError || error instanceof GitError) console.error(error.message);
  else console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
