/**
 * End-to-end over a synthetic repo with deliberately-known history.
 *
 * The fixture is the point: without a repo whose decisions are known in advance,
 * changes to the heuristics can only be judged on vibes. Every commit below
 * exists to exercise one branch of the three tests.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { openRepo, type Repo } from '../git/index.js';
import { detectDependencyDecisions } from './dependency.js';
import { rank, type RankResult } from './rank.js';

const exec = promisify(execFile);

let dir: string;
let repo: Repo;
let result: RankResult;

const at = (day: number) =>
  new Date(Date.UTC(2025, 0, 1 + day, 12, 0, 0)).toISOString();

async function git(args: string[], date?: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (date !== undefined) {
    env['GIT_AUTHOR_DATE'] = date;
    env['GIT_COMMITTER_DATE'] = date;
  }
  await exec('git', ['-C', dir, ...args], { env, windowsHide: true });
}

async function write(path: string, contents: string): Promise<void> {
  const full = join(dir, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

const manifest = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: deps, devDependencies: dev }, null, 2);

async function commit(subject: string, day: number): Promise<void> {
  await git(['add', '-A']);
  await git(['commit', '-m', subject, '--no-gpg-sign'], at(day));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retrace-fixture-'));

  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'fixture@example.com']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'commit.gpgsign', 'false']);

  // Day 0 — scaffold. Sixty files, framework defaults, nothing chosen.
  // Everything here must fail test 3.
  await write('package.json', manifest({ next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' }));
  for (let i = 0; i < 60; i += 1) {
    await write(`app/generated-${i}.tsx`, `export const Page${i} = () => null;\n`);
  }
  await commit('initial commit from create-next-app', 0);

  // Day 30 — a real choice, landed alone.
  await write('package.json', manifest({ next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0', prisma: '^5.0.0' }));
  await write('src/db.ts', `import { PrismaClient } from 'prisma';\nexport const db = new PrismaClient();\n`);
  await commit('add prisma', 30);

  // Day 120 — the swap. One commit, both sides. The strongest signal there is.
  await write('package.json', manifest({ next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0', 'drizzle-orm': '^0.45.0' }));
  await write('src/db.ts', `import { drizzle } from 'drizzle-orm/node-postgres';\nexport const db = drizzle(process.env.DATABASE_URL!);\n`);
  await write('src/users.ts', `import { eq } from 'drizzle-orm';\nexport { eq };\n`);
  await write('src/posts.ts', `import { sql } from 'drizzle-orm';\nexport { sql };\n`);
  await commit('swap ORM for drizzle', 120);

  // Day 150 — noise. Forty files, and a package with no catalogued alternative.
  await write('package.json', manifest({ next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0', 'drizzle-orm': '^0.45.0', lodash: '^4.17.0' }));
  for (let i = 0; i < 40; i += 1) {
    await write(`app/generated-${i}.tsx`, `export const Page${i} = () => null; // touched\n`);
  }
  await commit('housekeeping', 150);

  // Day 160 — a broken manifest, as happens mid-merge. Must be skipped without
  // making the next revision look like a mass re-add.
  await write('package.json', '{ "dependencies": { "drizzle-orm": ');
  await commit('wip: broken merge', 160);

  // Day 170 — repaired, plus two genuine additions, landed small.
  await write('package.json', manifest({ next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0', 'drizzle-orm': '^0.45.0', lodash: '^4.17.0', zod: '^3.23.0', pino: '^9.0.0' }));
  await write('src/schema.ts', `import { z } from 'zod';\nexport const User = z.object({ id: z.string() });\n`);
  await write('src/log.ts', `import pino from 'pino';\nexport const log = pino();\n`);
  await commit('validate request bodies and add logging', 170);

  // Day 200 — a swap buried in a sixty-file sweep. Regression guard: the
  // commit-size veto exists to catch dependencies riding along in generated
  // output, and generators originate rather than swap. Suppressing this threw
  // away real router and build-transform swaps in live repos.
  await write('package.json', manifest({ next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0', 'drizzle-orm': '^0.45.0', lodash: '^4.17.0', zod: '^3.23.0', winston: '^3.0.0' }));
  await write('src/log.ts', `import winston from 'winston';\nexport const log = winston.createLogger();\n`);
  for (let i = 0; i < 60; i += 1) {
    await write(`app/generated-${i}.tsx`, `export const Page${i} = () => null; // swept\n`);
  }
  await commit('refactor: sweep the app directory', 200);

  repo = await openRepo(dir);
  result = rank((await detectDependencyDecisions(repo)).candidates);
}, 120_000);

afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

const find = (name: string) => result.ranked.filter((c) => c.packageName === name);
const surfaced = () => result.ranked.filter((c) => c.suppressed === null);

describe('the three tests', () => {
  test('a same-commit swap is the top-ranked candidate', () => {
    const top = result.ranked[0];
    expect(top?.packageName).toBe('drizzle-orm');
    expect(top?.kind).toBe('replacement');
    expect(top?.displaced).toBe('prisma');
    expect(top?.suppressed).toBeNull();
  });

  test('the swap passes all three tests on its own evidence', () => {
    const swap = find('drizzle-orm')[0];
    expect(swap?.tests.alternative.pass).toBe(true);
    expect(swap?.tests.loadBearing.pass).toBe(true);
    expect(swap?.tests.deliberate.pass).toBe(true);
    expect(swap?.importingFiles).toBeGreaterThanOrEqual(3);
    expect(swap?.projectAgeDays).toBe(120);
  });

  // The filter that matters most: asking about create-next-app's choices is
  // exactly what makes the product look stupid.
  test.each(['next', 'react'])('scaffold dependency %s is suppressed as not deliberate', (name) => {
    const candidate = find(name)[0];
    expect(candidate?.suppressed).toBe('not deliberate');
    expect(candidate?.tests.deliberate.why).toMatch(/first commit/);
  });

  test('a framework-mandated package is not a candidate at all', () => {
    expect(find('react-dom')).toHaveLength(0);
  });

  test('a package with no catalogued alternative is suppressed, not surfaced', () => {
    const candidate = find('lodash')[0];
    expect(candidate?.suppressed).toBe('no known alternative');
  });

  test('a deliberate, load-bearing addition surfaces without a replacement', () => {
    const candidate = find('zod')[0];
    expect(candidate?.kind).toBe('origination');
    expect(candidate?.suppressed).toBeNull();
    expect(candidate?.tests.alternative.why).toMatch(/schema validation/);
  });
});

describe('a replacement cannot arrive by accident', () => {
  // Found against a real repo: a router swap and a babel→swc swap were both
  // discarded for landing in a busy commit. Size is evidence about
  // originations, not about swaps.
  test('a swap inside a sixty-file commit still surfaces', () => {
    const swap = find('winston')[0];
    expect(swap?.kind).toBe('replacement');
    expect(swap?.displaced).toBe('pino');
    expect(swap?.filesInCommit).toBeGreaterThan(50);
    expect(swap?.suppressed).toBeNull();
    expect(swap?.tests.deliberate.why).toMatch(/swap among 6\d changed files/);
  });

  test('an origination in that same commit is still suppressed', () => {
    // The veto is not disabled wholesale — it still applies to anything that
    // could have ridden along.
    const rodeAlong = result.ranked.filter(
      (c) => c.kind === 'origination' && c.filesInCommit > 50,
    );
    expect(rodeAlong.every((c) => c.suppressed === 'not deliberate')).toBe(true);
  });
});

describe('walking hostile history', () => {
  test('a broken manifest revision does not resurrect every dependency', () => {
    // If the walk diffed against null on the bad revision, every package would
    // appear added a second time at day 170.
    for (const name of ['next', 'react', 'drizzle-orm', 'lodash']) {
      expect(find(name).length, `${name} was detected more than once`).toBeLessThanOrEqual(1);
    }
  });

  test('the displaced package is consumed by its replacement, not double-counted', () => {
    const prisma = find('prisma');
    expect(prisma.every((c) => c.kind !== 'removal')).toBe(true);
  });
});

describe('the budget', () => {
  // A detector that surfaces everything is the same as no detector.
  test('surfaces a handful, not everything it found', () => {
    expect(surfaced().length).toBeGreaterThan(0);
    expect(surfaced().length).toBeLessThan(result.ranked.length);
  });

  test('every suppressed candidate carries its reason', () => {
    for (const candidate of result.ranked.filter((c) => c.suppressed !== null)) {
      expect(candidate.suppressedDetail, candidate.packageName).toBeTruthy();
    }
  });

  test('the calibration summary accounts for every candidate', () => {
    const dropped = Object.values(result.summary.suppressed).reduce((a, b) => a + b, 0);
    expect(result.summary.surfaced + dropped).toBe(result.summary.total);
  });
});
