/**
 * Local identity against a real database: the builder row, local clones as
 * repos, and the once-per-identity question.
 */
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { repos, users } from '../../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import { authorIdentities, openRepo } from '../git/index.js';
import { loadIdentitySet, recordIdentity, unresolvedIdentities } from './identity.js';
import { ensureBuilder, registerLocalClone } from './local.js';

const BUILDER = { githubUserId: 999000101, login: 'identity-test' };

describe.skipIf(skipWithoutDatabase())('local identity', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let userId: string;

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.commit('template: vite_react_shadcn_ts_2026-04-20', {
      author: { name: 'Lovable', email: 'noreply@lovable.dev' },
    });
    await fixture.commit('Changes', {
      day: 1,
      author: {
        name: 'gpt-engineer-app[bot]',
        email: '159125892+gpt-engineer-app[bot]@users.noreply.github.com',
      },
    });
    for (const day of [2, 3]) {
      await fixture.commit('my change', { day, author: { name: 'Me', email: 'Me@Example.com' } });
    }
    await fixture.commit('their change', {
      day: 4,
      author: { name: 'Colleague', email: 'colleague@example.com' },
    });
  });

  afterAll(async () => {
    await db?.delete(repos).where(eq(repos.name, fixture.dir.split(/[\\/]/).pop() ?? ''));
    await db?.delete(users).where(eq(users.githubUserId, BUILDER.githubUserId));
    await pool?.end();
    await fixture?.remove();
  });

  test('the builder row is created once and survives a login rename', async () => {
    userId = await ensureBuilder(db, BUILDER);
    expect(await ensureBuilder(db, BUILDER)).toBe(userId);
    expect(await ensureBuilder(db, { ...BUILDER, login: 'renamed' })).toBe(userId);
  });

  test('a local clone is one repo however its path is written', async () => {
    const repo = await openRepo(fixture.dir);
    const first = await registerLocalClone(db, repo);
    const again = await registerLocalClone(db, await openRepo(`${fixture.dir}/`));
    expect(again.id).toBe(first.id);
    expect(first.rootSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('only identities the catalogues cannot explain are asked about', async () => {
    const repo = await openRepo(fixture.dir);
    const identities = await authorIdentities(repo);
    const asked = unresolvedIdentities(identities, await loadIdentitySet(db, userId));
    // Lowercased, most commits first. Neither the Lovable agent nor the
    // Lovable template author is asked about.
    expect(asked.map((i) => i.email)).toEqual(['me@example.com', 'colleague@example.com']);
  });

  test('answers are remembered, and can be corrected', async () => {
    await recordIdentity(db, userId, { email: 'ME@example.com', name: 'Me' }, 'me');
    await recordIdentity(db, userId, { email: 'colleague@example.com', name: 'C' }, 'other');

    let known = await loadIdentitySet(db, userId);
    expect([...known.mine]).toEqual(['me@example.com']);
    expect([...known.others]).toEqual(['colleague@example.com']);

    // Changing your mind moves the email across; it is never in both.
    await recordIdentity(db, userId, { email: 'colleague@example.com', name: 'C' }, 'me');
    known = await loadIdentitySet(db, userId);
    expect(known.mine.has('colleague@example.com')).toBe(true);
    expect(known.others.has('colleague@example.com')).toBe(false);
  });

  test("claiming someone else's confirmed email fails loudly", async () => {
    const otherUser = await ensureBuilder(db, { githubUserId: 999000102, login: 'other' });
    await expect(
      recordIdentity(db, otherUser, { email: 'me@example.com', name: 'Me' }, 'me'),
    ).rejects.toThrow(/already claimed/);
    await db.delete(users).where(eq(users.id, otherUser));
  });
});
