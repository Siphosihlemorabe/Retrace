/**
 * 0007 end to end against the test database, on a fixture shaped like the
 * builder's repos: a Lovable template root, agent commits, the builder's own
 * commits, and one with a Claude co-author trailer.
 */
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { repos, users } from '../../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import { recordIdentity } from '../decisions/identity.js';
import { ensureBuilder, registerLocalClone } from '../decisions/local.js';
import { openRepo, type Repo } from '../git/index.js';
import { loadCoverage, type GoalCoverage } from './coverage.js';
import { setGoals, setObjective, stopGoal } from './goals.js';
import { relabelLines, scanNewCommits, type ScanScope } from './scan.js';
import { outcomesOf, resolveSkill } from './sync.js';

const ME = { name: 'Me', email: 'goals-test-me@example.com' };
const AGENT = { name: 'gpt-engineer-app[bot]', email: '159125892+gpt-engineer-app[bot]@users.noreply.github.com' };

describe.skipIf(skipWithoutDatabase())('goals, scanning and coverage', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let repo: Repo;
  let scope: ScanScope;
  let agentAggregateSha: string;

  const sql = () => loadCoverage(db, scope.userId, scope.repoId).then((c) => c.find((g) => g.skill.slug === 'sql') as GoalCoverage);
  const outcome = (cov: GoalCoverage, slug: string) => cov.outcomes.find((o) => o.slug === slug);

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();

    // 1. The template root.
    await fixture.write('README.md', '# app\n');
    await fixture.commit('template: vite_react_shadcn_ts_2026-04-20', {
      author: { name: 'Lovable', email: 'noreply@lovable.dev' },
    });
    // 2. Before any goal: the agent writes a JOIN.
    await fixture.write('db/report.sql', 'SELECT o.id, c.name\nFROM orders o\nLEFT JOIN customers c ON c.id = o.customer_id;\n');
    await fixture.commit('Changes', { day: 1, author: AGENT });

    const userId = await ensureBuilder(db, { githubUserId: 999000701, login: 'goals-test' });
    await recordIdentity(db, userId, ME, 'me');
    repo = await openRepo(fixture.dir);
    const clone = await registerLocalClone(db, repo);
    scope = { db, userId, repo, repoId: clone.id };
  }, 60_000);

  afterAll(async () => {
    if (scope !== undefined) {
      await db.delete(repos).where(eq(repos.id, scope.repoId));
      await db.delete(users).where(eq(users.id, scope.userId));
    }
    await pool?.end();
    await fixture?.remove();
  });

  test('setting goals sights history and finds what was already there, as before the goal', async () => {
    const result = await setGoals(scope, [
      { name: 'SQL', objective: ['sql.joins', 'sql.aggregates', 'sql.indexes'] },
      { name: 'Redis' },
    ].map((g) => ({ objective: 'all' as const, ...g })));

    expect(result.backfilled).toBe(2);
    expect(result.goals.map((g) => [g.skill, g.hasOutcomeList])).toEqual([
      ['sql', true],
      ['redis', false],
    ]);

    const cov = await sql();
    const joins = outcome(cov, 'sql.joins');
    expect(joins?.status).toBe('touched');
    expect(joins?.sightings[0]).toMatchObject({ when: 'before_goal', authorship: 'agent', path: 'db/report.sql' });
  });

  test('new commits are scanned for the lines they add, each with its author', async () => {
    // 3. The builder's own JOIN.
    await fixture.write('db/bookings.sql', 'SELECT b.id\nFROM bookings b\nINNER JOIN rooms r ON r.id = b.room_id;\n');
    await fixture.commit('bookings query', { day: 2, author: ME });
    // 4. The agent's GROUP BY.
    await fixture.write('db/stats.sql', 'SELECT status, COUNT(*)\nFROM orders\nGROUP BY status;\n');
    agentAggregateSha = await fixture.commit('Changes', { day: 3, author: AGENT });
    // 5. The builder, with Claude, adds an index.
    await fixture.write('migrations/0002_index.sql', 'CREATE INDEX orders_status_idx ON orders (status);\n');
    await fixture.commit('index orders by status', {
      day: 4,
      author: ME,
      body: 'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
    });

    expect((await scanNewCommits(scope)).commits).toBe(3);
    // A second scan finds nothing new.
    expect((await scanNewCommits(scope)).commits).toBe(0);

    const cov = await sql();
    expect(outcome(cov, 'sql.joins')?.sightings.map((s) => [s.when, s.authorship, s.path])).toEqual([
      ['after_goal', 'builder', 'db/bookings.sql'],
      ['before_goal', 'agent', 'db/report.sql'],
    ]);
    expect(outcome(cov, 'sql.aggregates')?.sightings[0]).toMatchObject({ when: 'after_goal', authorship: 'agent' });
    expect(outcome(cov, 'sql.indexes')?.sightings[0]).toMatchObject({ when: 'after_goal', authorship: 'builder_with_agent' });
    // The old JOIN in report.sql is not re-credited to a later commit.
    expect(outcome(cov, 'sql.joins')?.sightings).toHaveLength(2);
  });

  test('nothing is learned until documented and checked: 0%, out of the full list', async () => {
    const cov = await sql();
    expect(cov.total).toBe(11);
    expect(cov.percentLearned).toBe(0);
    expect(cov.objective).toEqual({ met: 0, total: 3 });
    expect(cov.touched).toBeGreaterThanOrEqual(3);
    expect(cov.outcomes.every((o) => o.status !== 'learned')).toBe(true);
  });

  test('unticking an outcome changes the objective, never the denominator', async () => {
    const skill = await resolveSkill(db, 'SQL');
    const indexes = (await outcomesOf(db, [skill.id])).find((o) => o.slug === 'sql.indexes');
    const goalId = (await sql()).goalId;
    await setObjective(scope, goalId, indexes?.id ?? '', false);
    const cov = await sql();
    expect(cov.objective.total).toBe(2);
    expect(cov.total).toBe(11);
  });

  test("a relabel overrides commit history for exactly those lines", async () => {
    const changed = await relabelLines(scope, {
      sha: agentAggregateSha,
      path: 'db/stats.sql',
      lineStart: 1,
      lineEnd: 3,
      label: 'me',
    });
    expect(changed).toBeGreaterThanOrEqual(1);
    const cov = await sql();
    expect(outcome(cov, 'sql.aggregates')?.sightings[0]?.authorship).toBe('builder');
    // The agent's JOIN in report.sql is untouched by a relabel elsewhere.
    expect(outcome(cov, 'sql.joins')?.sightings.find((s) => s.path === 'db/report.sql')?.authorship).toBe('agent');
  });

  test('a skill without a built-in list is a goal with nothing to show yet', async () => {
    const all = await loadCoverage(db, scope.userId, scope.repoId);
    const redis = all.find((g) => g.skill.slug === 'redis');
    expect(redis).toMatchObject({ hasOutcomeList: false, percentLearned: null, total: 0 });
  });

  test('stopping a goal hides it and keeps its history; setting it again brings the same goal back', async () => {
    const before = await sql();
    expect(await stopGoal(scope, before.goalId)).toBe(true);
    expect((await loadCoverage(db, scope.userId, scope.repoId)).some((g) => g.skill.slug === 'sql')).toBe(false);

    await setGoals(scope, [{ name: 'SQL', objective: 'all' }]);
    const after = await sql();
    expect(after.goalId).toBe(before.goalId);
    expect(after.declaredAtSha).toBe(before.declaredAtSha);
    expect(after.touched).toBe(before.touched);
  });
});
