import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { candidates, repos, users } from '../../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import { toCandidateRow } from '../detect/candidate-row.js';
import type { RankedCandidate } from '../detect/rank.js';
import { openRepo } from '../git/index.js';
import { markShown, nextCandidates, skipCandidate, weeklyBudget } from './budget.js';
import { ensureBuilder, registerLocalClone } from './local.js';

const base: RankedCandidate = {
  kind: 'dependency_choice',
  packageName: 'x',
  subjectKey: 'npm:x',
  displaced: null,
  category: null,
  categoryLabel: null,
  sha: 'f'.repeat(40),
  shortSha: 'fffffff',
  date: new Date(),
  subject: 's',
  authorEmail: 'me@example.com',
  filesInCommit: 2,
  commitIndex: 2,
  commitCount: 10,
  authorship: { authorship: 'builder', rule: 'your identity', actor: null },
  introducedAlone: true,
  looksScaffoldGenerated: false,
  importingFiles: 3,
  tests: {
    alternative: { pass: true, why: '' },
    loadBearing: { pass: true, why: '' },
    deliberate: { pass: true, why: '' },
  },
  score: 0.5,
  suppressed: null,
  suppressedDetail: null,
};

describe.skipIf(skipWithoutDatabase())('weekly ask budget', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let ctx: { repoId: string; userId: string; manifestPath: string };

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.commit('root');
    const userId = await ensureBuilder(db, { githubUserId: 999000301, login: 'budget-test' });
    const clone = await registerLocalClone(db, await openRepo(fixture.dir));
    ctx = { repoId: clone.id, userId, manifestPath: 'package.json' };
  });

  beforeEach(async () => {
    await db.delete(candidates).where(eq(candidates.repoId, ctx.repoId));
    const seed = (key: string, score: number, authorship = base.authorship) =>
      toCandidateRow({ ...base, subjectKey: key, packageName: key, score, authorship }, ctx);
    await db.insert(candidates).values([
      seed('npm:a', 0.9),
      seed('npm:b', 0.8, { authorship: 'agent', rule: 'known agent', actor: 'Lovable' }),
      seed('npm:c', 0.7),
      seed('npm:d', 0.6),
      // Never offered: the frame for an unconfirmed author would be a guess.
      seed('npm:unknown', 1.0, { authorship: 'unknown', rule: 'r', actor: null }),
    ]);
  });

  afterAll(async () => {
    await db?.delete(repos).where(eq(repos.id, ctx.repoId));
    await db?.delete(users).where(eq(users.id, ctx.userId));
    await pool?.end();
    await fixture?.remove();
  });

  test('offers the best askable candidates, up to the limit', async () => {
    const next = await nextCandidates(db, ctx.userId);
    expect(next.map((c) => c.subjectKey)).toEqual(['npm:a', 'npm:b', 'npm:c']);
  });

  test('showing spends the budget over a rolling week', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    for (const c of await nextCandidates(db, ctx.userId, { now })) await markShown(db, c.id, now);

    expect(await weeklyBudget(db, ctx.userId, { now })).toMatchObject({ shownThisWeek: 3, remaining: 0 });
    expect(await nextCandidates(db, ctx.userId, { now })).toEqual([]);

    const eightDaysLater = new Date(now.getTime() + 8 * 24 * 3600 * 1000);
    expect((await weeklyBudget(db, ctx.userId, { now: eightDaysLater })).remaining).toBe(3);
  });

  test('a skip returns a candidate to the pool; the third skip expires it', async () => {
    const [first] = await nextCandidates(db, ctx.userId);
    if (first === undefined) throw new Error('no candidate');
    expect(await skipCandidate(db, first.id)).toBe('pending');
    expect(await skipCandidate(db, first.id)).toBe('pending');
    expect(await skipCandidate(db, first.id)).toBe('expired');
    expect((await nextCandidates(db, ctx.userId)).map((c) => c.subjectKey)).not.toContain('npm:a');
    await expect(skipCandidate(db, first.id)).rejects.toThrow(/not pending/);
  });
});
