import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, test } from 'vitest';

import { questions, repos, userSettings, users } from '../../db/schema.js';
import { openTestDb, rejectsWithConstraint, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import { ensureBuilder, registerLocalClone } from '../decisions/local.js';
import { openRepo } from '../git/index.js';

describe.skipIf(skipWithoutDatabase())('0009 schema guarantees', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let userId: string;
  let repoId: string;

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.commit('root');
    userId = await ensureBuilder(db, { githubUserId: 999001101, login: 'q-schema' });
    repoId = (await registerLocalClone(db, await openRepo(fixture.dir))).id;
  });

  afterAll(async () => {
    await db?.delete(repos).where(eq(repos.id, repoId));
    await db?.delete(users).where(eq(users.id, userId));
    await pool?.end();
    await fixture?.remove();
  });

  test('a question needs exactly one target', async () => {
    await rejectsWithConstraint(
      db.insert(questions).values({ userId, repoId, targetKind: 'outcome_sighting', text: 'x', foundBy: 'rule', promptVersion: 1 }),
      /questions_one_target/,
    );
  });

  test('questions per week can be raised, never below three (the builder’s rule)', async () => {
    await rejectsWithConstraint(
      db.insert(userSettings).values({ userId, questionsPerWeek: 2 }),
      /user_settings_questions_per_week/,
    );
    await db.insert(userSettings).values({ userId, questionsPerWeek: 5 });
  });
});
