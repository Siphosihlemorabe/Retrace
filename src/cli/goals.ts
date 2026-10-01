/**
 * `npm run goals <repo>` — set what you want to learn in a project (0007).
 *
 *   npm run goals ../bookings-api              an existing project
 *   npm run goals -- --new ../bookings-api     a new project: folder, git init, first commit
 *   npm run goals ../x -- --skill SQL --skill Docker    no questions asked: every outcome ticked
 *
 * Any skill can be a goal. SQL, Docker and Node/REST have outcome lists now;
 * any other skill's list is drafted by a model and reviewed by you (0009).
 */
import { parseArgs } from 'node:util';

import { registerLocalClone } from '../core/decisions/local.js';
import { BUILTIN_SKILLS, findBuiltinSkill } from '../core/outcomes/catalog/index.js';
import { setGoals, type GoalRequest } from '../core/outcomes/goals.js';
import { commitPositions, GitError, openRepo } from '../core/git/index.js';
import { createGithubRepo, createProjectFolder, githubCliReady } from '../core/git/new-project.js';
import { openSession, SetupError } from '../session.js';
import { identitySetup } from './identity-setup.js';
import { createPrompter, type Prompter } from './prompt.js';

const USAGE = `
Usage: npm run goals <path-to-repo> [options]

  --new            create <path> as a new project (folder, git init, first commit)
  --skill <name>   set a goal without questions (repeatable); every outcome ticked
`.trim();

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      new: { type: 'boolean', default: false },
      skill: { type: 'string', multiple: true },
      help: { type: 'boolean', default: false },
    },
  });
  const target = positionals[0];
  if (values.help === true || target === undefined) {
    console.log(USAGE);
    return values.help === true ? 0 : 1;
  }

  const session = await openSession();
  const prompt = createPrompter();
  try {
    const repo = values.new === true ? await createProjectFolder(target) : await openRepo(target);
    if (values.new === true) {
      console.log(`\n  Created ${repo.path} with an empty first commit.`);
      await offerGithub(prompt, repo);
    }
    const clone = await registerLocalClone(session.db, repo);
    await identitySetup(session, repo, clone, prompt);

    const requests =
      values.skill !== undefined && values.skill.length > 0
        ? values.skill.map((name): GoalRequest => ({ name, objective: 'all' }))
        : await askForGoals(prompt);
    if (requests.length === 0) {
      console.log('  No goals set.');
      return 0;
    }

    console.log('\n  Reading the project…');
    const result = await setGoals({ db: session.db, userId: session.userId, repo, repoId: clone.id }, requests);
    const { total } = await commitPositions(repo);

    console.log(`\n  Saved at commit ${result.declaredAtSha.slice(0, 7)} (commit ${total} of ${total}). New commits are checked from here on.`);
    for (const g of result.goals) {
      const name = findBuiltinSkill(g.skill)?.name ?? g.skill;
      console.log(
        `    ${name}${g.created ? '' : ' (updated)'}` +
          (g.hasOutcomeList ? '' : ' — its outcome list will be drafted for you to review (coming in 0009)'),
      );
    }
    if (result.alreadyTouched > 0) {
      console.log(`  ${result.alreadyTouched} places in the existing code already touch your goals. See them with \`npm run coverage ${target}\`.`);
    }
    console.log('');
    return 0;
  } finally {
    prompt.close();
    await session.end();
  }
}

/** Creating the GitHub repo changes the builder's account: asked, never assumed. */
async function offerGithub(prompt: Prompter, repo: Awaited<ReturnType<typeof openRepo>>): Promise<void> {
  if (!(await githubCliReady())) {
    console.log('  (To also create it on GitHub, install GitHub\'s `gh` tool and run `gh auth login`.)');
    return;
  }
  const answer = await prompt.choose(
    '\n  Also create this repo on GitHub and push the first commit?\n    [n] No   [p] Yes, private   [u] Yes, public\n  > ',
    ['n', 'p', 'u'],
  );
  if (answer === null || answer === 'n') return;
  const url = await createGithubRepo(repo, answer === 'p' ? 'private' : 'public');
  console.log(`  Created on GitHub: ${url}`);
}

async function askForGoals(prompt: Prompter): Promise<GoalRequest[]> {
  console.log('\n  What do you want to learn in this project?');
  console.log(`  Ready-made outcome lists: ${BUILTIN_SKILLS.map((s) => s.name).join(', ')}. Any other skill works too.`);
  const line = await prompt.line('  Skills, comma-separated (e.g. SQL, Docker, Redis) > ');
  const names = (line ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');

  const requests: GoalRequest[] = [];
  for (const name of names) {
    const skill = findBuiltinSkill(name);
    if (skill === null) {
      requests.push({ name, objective: 'all' });
      continue;
    }
    console.log(`\n  ${skill.name}: your objective for this project. Everything is ticked; untick what you don't want to work on.`);
    skill.outcomes.forEach((o, i) => console.log(`    ${String(i + 1).padStart(2)}. ${o.name.padEnd(26)} ${o.description}`));
    const untick = await prompt.line('  Numbers to untick, comma-separated (enter for none) > ');
    const drop = new Set(
      (untick ?? '')
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n)),
    );
    requests.push({ name: skill.name, objective: skill.outcomes.filter((_, i) => !drop.has(i + 1)).map((o) => o.slug) });
  }
  return requests;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof SetupError || error instanceof GitError) console.error(error.message);
  else console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
