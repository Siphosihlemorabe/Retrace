/**
 * Who wrote each line, v2: your own root commit reads "not confirmed", and a
 * relabel follows its lines into later commits that leave them alone.
 */
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { repos, users } from '../../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import { loadIdentitySet, recordIdentity } from '../decisions/identity.js';
import { ensureBuilder, registerLocalClone } from '../decisions/local.js';
import { openRepo, type Repo } from '../git/index.js';
import { blameAuthors, CommitClassifier } from './line-authorship.js';
import { labelsFor, relabelLines, type ScanScope } from './scan.js';

const ME = { name: 'Me', email: 'line-authorship-me@example.com' };
const STRANGER = { name: 'Someone', email: 'line-authorship-someone@example.com' };
const AGENT = { name: 'gpt-engineer-app[bot]', email: '159125892+gpt-engineer-app[bot]@users.noreply.github.com' };

describe.skipIf(skipWithoutDatabase())('line authorship', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let repo: Repo;
  let scope: ScanScope;
  let shas: { root: string; agent: string; mine: string; later: string };

  const authors = async (sha: string, path: string, start: number, end: number) =>
    blameAuthors(repo, new CommitClassifier(repo, await loadIdentitySet(db, scope.userId)), sha, path, start, end, await labelsFor(db, scope.repoId));

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.write('src/app.ts', 'export const a = 1;\n');
    const root = await fixture.commit('initial commit', { author: ME });
    await fixture.write('src/db.ts', 'const one = 1;\nconst two = 2;\nconst three = 3;\n');
    const agent = await fixture.commit('Changes', { day: 1, author: AGENT });
    // Two lines added above the agent's: its lines move down by two.
    await fixture.write('src/db.ts', '// mine\n// also mine\nconst one = 1;\nconst two = 2;\nconst three = 3;\n');
    const mine = await fixture.commit('notes', { day: 2, author: ME });
    await fixture.write('README.md', '# app\n');
    const later = await fixture.commit('readme', { day: 3, author: ME });
    shas = { root, agent, mine, later };

    const userId = await ensureBuilder(db, { githubUserId: 999000941, login: 'line-authorship' });
    await recordIdentity(db, userId, ME, 'me');
    repo = await openRepo(fixture.dir);
    scope = { db, userId, repo, repoId: (await registerLocalClone(db, repo)).id };
  }, 60_000);

  afterAll(async () => {
    if (scope !== undefined) {
      await db.delete(repos).where(eq(repos.id, scope.repoId));
      await db.delete(users).where(eq(users.id, scope.userId));
    }
    await pool?.end();
    await fixture?.remove();
  });

  test('your own root commit is not confirmed, rather than called a template', async () => {
    const [line] = await authors(shas.later, 'src/app.ts', 1, 1);
    expect(line).toMatchObject({ authorship: 'unknown', sha: shas.root });
  });

  test('a root commit by someone else is still a template', async () => {
    const other = await createFixtureRepo();
    try {
      await other.write('a.ts', 'x\n');
      const sha = await other.commit('init', { author: STRANGER });
      const r = await openRepo(other.dir);
      const [line] = await blameAuthors(r, new CommitClassifier(r, await loadIdentitySet(db, scope.userId)), sha, 'a.ts', 1, 1);
      expect(line?.authorship).toBe('template');
    } finally {
      await other.remove();
    }
  });

  test('a relabel follows its lines into later commits, wherever they moved', async () => {
    // Relabelled while looking at `mine`, where the agent's lines are 3–5.
    await relabelLines(scope, { sha: shas.mine, path: 'src/db.ts', lineStart: 4, lineEnd: 4, label: 'me' });
    const lines = await authors(shas.later, 'src/db.ts', 1, 5);
    expect(lines.map((l) => [l.line, l.authorship, l.relabelled])).toEqual([
      [1, 'builder', false],
      [2, 'builder', false],
      [3, 'agent', false],
      [4, 'builder', true],
      [5, 'agent', false],
    ]);
    // And at the commit that wrote them, where the same line is number 2.
    const atAgent = await authors(shas.agent, 'src/db.ts', 1, 3);
    expect(atAgent.map((l) => l.relabelled)).toEqual([false, true, false]);
  });
});
