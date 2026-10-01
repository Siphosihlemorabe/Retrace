/**
 * `npm run coverage <repo>` — what your code touches of your goals, who wrote
 * it, and how much is learned (0007). Scans new commits first.
 *
 * Learned needs documenting (0010) and a passed check (0011), so until those
 * exist it reads 0%. That is the honest number, not a bug.
 */
import { parseArgs } from 'node:util';

import { describeAuthorship } from '../core/decisions/framing.js';
import { registerLocalClone } from '../core/decisions/local.js';
import { loadCoverage, type GoalCoverage, type OutcomeCoverage } from '../core/outcomes/coverage.js';
import { scanNewCommits } from '../core/outcomes/scan.js';
import { commitPositions, GitError, openRepo } from '../core/git/index.js';
import { openSession, SetupError } from '../session.js';
import { identitySetup } from './identity-setup.js';
import { createPrompter } from './prompt.js';

async function main(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const target = positionals[0];
  if (target === undefined) {
    console.log('Usage: npm run coverage <path-to-repo>');
    return 1;
  }

  const session = await openSession();
  const prompt = createPrompter();
  try {
    const repo = await openRepo(target);
    const clone = await registerLocalClone(session.db, repo);
    await identitySetup(session, repo, clone, prompt);

    const scanned = await scanNewCommits({ db: session.db, userId: session.userId, repo, repoId: clone.id });
    const goals = await loadCoverage(session.db, session.userId, clone.id);
    if (goals.length === 0) {
      console.log(`\n  No goals for ${clone.name} yet. Set some with \`npm run goals ${target}\`.\n`);
      return 0;
    }

    const positions = await commitPositions(repo);
    const at = (sha: string) => `commit ${positions.indexOf.get(sha) ?? '?'}`;
    if (scanned.commits > 0) console.log(`\n  Checked ${scanned.commits} new commit${scanned.commits === 1 ? '' : 's'}.`);

    for (const g of goals) printGoal(g, clone.name, at);
    console.log('');
    return 0;
  } finally {
    prompt.close();
    await session.end();
  }
}

const STATUS: Record<OutcomeCoverage['status'], string> = {
  learned: '✓ learned  ',
  documented: '✎ documented',
  touched: '◐ touched  ',
  not_touched: '· not yet  ',
};

function printGoal(g: GoalCoverage, project: string, at: (sha: string) => string): void {
  console.log(`\n  ${g.skill.name} in ${project}`);
  if (!g.hasOutcomeList) {
    console.log('    Its outcome list will be drafted for you to review (coming in 0009).');
    return;
  }
  console.log(
    `    ${g.percentLearned}% learned (${g.learned} of ${g.total}) · objective ${g.objective.met} of ${g.objective.total} met` +
      ` · touched ${g.touched} of ${g.total}, waiting for you to document and explain them`,
  );
  for (const o of g.outcomes) {
    const best = o.sightings[0];
    const mark = o.inObjective ? ' ' : '·';
    if (best === undefined) {
      console.log(`  ${mark} ${STATUS[o.status]}  ${o.name}`);
      continue;
    }
    const who = describeAuthorship({ authorship: best.authorship, rule: '', actor: null }, '').replace(/ \(\)$/, '');
    const when = best.when === 'before_goal' ? ', before goal' : '';
    const more = o.sightings.length > 1 ? ` (+${o.sightings.length - 1} more)` : '';
    const via = best.via === 'orm' ? ' · via ORM' : '';
    console.log(
      `  ${mark} ${STATUS[o.status]}  ${o.name.padEnd(24)} ${who}${when}${via} · ${best.path}:${best.lineStart}-${best.lineEnd} · ${best.sha.slice(0, 7)} ${best.when === 'before_goal' ? 'in the code at ' : ''}${at(best.sha)}${more}`,
    );
  }
  console.log('    (· in the left margin: not in your objective for this project, still counted out of the full list)');
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof SetupError || error instanceof GitError) console.error(error.message);
  else console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
