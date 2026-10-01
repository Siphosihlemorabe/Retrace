import { and, eq, isNull } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { learningGoals, repos, skillOutcomes, skills, users } from '../../db/schema.js';
import { openTestDb, rejectsWithConstraint, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import { ensureBuilder, registerLocalClone } from '../decisions/local.js';
import { openRepo } from '../git/index.js';
import { BUILTIN_SKILLS } from './catalog/index.js';
import { outcomesOf, resolveSkill, syncCatalogue } from './sync.js';

describe.skipIf(skipWithoutDatabase())('catalogue sync and the 0007 schema', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let userId: string;
  let repoId: string;

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.commit('root');
    userId = await ensureBuilder(db, { githubUserId: 999000601, login: 'sync-test' });
    repoId = (await registerLocalClone(db, await openRepo(fixture.dir))).id;
  });

  afterAll(async () => {
    await db?.delete(repos).where(eq(repos.id, repoId));
    await db?.delete(users).where(eq(users.id, userId));
    await db?.delete(skills).where(eq(skills.slug, 'redis-sync-test'));
    await pool?.end();
    await fixture?.remove();
  });

  test('every built-in outcome is synced, in order, and syncing twice changes nothing', async () => {
    await syncCatalogue(db);
    await syncCatalogue(db);
    for (const skill of BUILTIN_SKILLS) {
      const ref = await resolveSkill(db, skill.name);
      const rows = await outcomesOf(db, [ref.id]);
      expect(rows.map((r) => r.slug)).toEqual(skill.outcomes.map((o) => o.slug));
    }
  });

  test('aliases resolve to the built-in skill', async () => {
    expect((await resolveSkill(db, 'Postgres')).slug).toBe('sql');
    expect((await resolveSkill(db, 'docker compose')).slug).toBe('docker');
  });

  test('any other skill gets a row of its own, with no outcomes yet', async () => {
    const ref = await resolveSkill(db, 'Redis Sync Test');
    expect(ref).toMatchObject({ slug: 'redis-sync-test', builtin: false });
    expect(await outcomesOf(db, [ref.id])).toEqual([]);
    expect((await resolveSkill(db, 'redis sync test')).id).toBe(ref.id);
  });

  test('an outcome removed from code is retired, not deleted', async () => {
    const [row] = await db
      .select()
      .from(skillOutcomes)
      .where(eq(skillOutcomes.slug, 'sql.window_functions'));
    if (row === undefined) throw new Error('missing');
    await db.insert(skillOutcomes).values({
      skillId: row.skillId,
      slug: 'sql.removed_for_test',
      name: 'x',
      description: 'x',
      ordinal: 99,
    });
    await syncCatalogue(db);
    const [retired] = await db.select().from(skillOutcomes).where(eq(skillOutcomes.slug, 'sql.removed_for_test'));
    expect(retired?.retiredAt).toBeInstanceOf(Date);
    const live = await db
      .select()
      .from(skillOutcomes)
      .where(and(eq(skillOutcomes.slug, 'sql.removed_for_test'), isNull(skillOutcomes.retiredAt)));
    expect(live).toEqual([]);
    await db.delete(skillOutcomes).where(eq(skillOutcomes.slug, 'sql.removed_for_test'));
  });

  test('an intent goal needs a repo, a skill and the commit it was set at', async () => {
    const sql = await resolveSkill(db, 'SQL');
    await rejectsWithConstraint(
      db.insert(learningGoals).values({ userId, title: 'x', kind: 'intent', skillId: sql.id }),
      /learning_goals_intent_fields/,
    );
  });

  test('one goal per skill per project', async () => {
    const sql = await resolveSkill(db, 'SQL');
    const goal = { userId, title: 'SQL', kind: 'intent', skillId: sql.id, repoId, declaredAtSha: 'a'.repeat(40) };
    await db.insert(learningGoals).values(goal);
    await rejectsWithConstraint(db.insert(learningGoals).values(goal), /learning_goals_intent_unq/);
    await db.delete(learningGoals).where(eq(learningGoals.userId, userId));
  });
});
