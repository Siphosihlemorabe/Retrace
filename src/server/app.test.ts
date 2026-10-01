/**
 * The local API end to end against the test database, over a fixture repo
 * where the builder's agent swapped the router — plus the guards that make an
 * unauthenticated local server acceptable.
 */
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { repos, users } from '../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../db/testing.js';
import type { Db } from '../db/types.js';
import { ensureBuilder } from '../core/decisions/local.js';
import { createFixtureRepo, type FixtureRepo } from '../test/fixture-repo.js';
import type {
  AnswerResponse,
  DecisionsResponse,
  IdentitiesResponse,
  QuestionsResponse,
  RefreshResponse,
  RepoView,
  ReviseResponse,
} from './api-types.js';
import { createApp } from './app.js';

const AGENT = { name: 'gpt-engineer-app[bot]', email: '159125892+gpt-engineer-app[bot]@users.noreply.github.com' };
// Unique to this file: identity emails are globally unique, and test files run in parallel.
const ME = { name: 'Me', email: 'api-test-me@example.com' };
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'f', dependencies: deps }, null, 2);

describe.skipIf(skipWithoutDatabase())('local API', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let userId: string;
  let app: ReturnType<typeof createApp>;
  let repo: RepoView;

  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { host: '127.0.0.1:3000', 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  const post = (path: string, payload: unknown) => call(path, { method: 'POST', body: JSON.stringify(payload) });

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.write('package.json', pkg({ '@tanstack/react-router': '^1.0.0' }));
    await fixture.commit('template: tanstack_start_ts_2026-05-06', {
      author: { name: 'Lovable', email: 'noreply@lovable.dev' },
    });
    await fixture.write('package.json', pkg({ 'react-router-dom': '^7.0.0' }));
    for (const f of ['src/App.tsx', 'src/a.ts', 'src/b.ts']) {
      await fixture.write(f, `import { Link } from 'react-router-dom';\n`);
    }
    await fixture.commit('Changes', { day: 1, author: AGENT });
    await fixture.commit('tidy', { day: 2, author: ME });

    userId = await ensureBuilder(db, { githubUserId: 999000501, login: 'api-test' });
    app = createApp({ db, userId, login: 'api-test' });
  });

  afterAll(async () => {
    if (repo !== undefined) await db?.delete(repos).where(eq(repos.id, repo.id));
    await db?.delete(users).where(eq(users.id, userId));
    await pool?.end();
    await fixture?.remove();
  });

  describe('guards', () => {
    test('a foreign Host is refused (DNS rebinding)', async () => {
      const res = await app.request('/api/me', { headers: { host: 'evil.example:3000' } });
      expect(res.status).toBe(403);
    });

    test('a write that is not JSON is refused (cross-site forms)', async () => {
      const res = await app.request('/api/repos', {
        method: 'POST',
        headers: { host: 'localhost:3000', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'path=/etc',
      });
      expect(res.status).toBe(415);
    });

    test('a bad body is a 400 with a reason, and a bad id is a 404', async () => {
      const res = await post('/api/repos', { nope: true });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/path/);
      expect((await call('/api/repos/not-a-uuid/questions')).status).toBe(404);
    });

    test('a path that is not a git repo is a 400', async () => {
      expect((await post('/api/repos', { path: '/definitely/not/a/repo' })).status).toBe(400);
    });
  });

  describe('the capture loop', () => {
    let questionId: string;
    let decisionId: string;

    test('register the clone, confirm identity, refresh', async () => {
      const res = await post('/api/repos', { path: fixture.dir });
      expect(res.status).toBe(201);
      repo = (await res.json()) as RepoView;

      const ids = (await (await call(`/api/repos/${repo.id}/identities`)).json()) as IdentitiesResponse;
      expect(ids.unresolved.map((i) => i.email)).toEqual([ME.email]);
      expect((await post('/api/identities', { email: ME.email, name: ME.name, verdict: 'me' })).status).toBe(200);

      const refreshed = (await (await post(`/api/repos/${repo.id}/refresh`, {})).json()) as RefreshResponse;
      expect(refreshed.inserted).toBe(1);
    });

    test("questions come in the CLI's wording, framed by who made the change", async () => {
      const q = (await (await call(`/api/repos/${repo.id}/questions`)).json()) as QuestionsResponse;
      expect(q.budget).toMatchObject({ limit: 3, shownThisWeek: 0, remaining: 3 });
      const first = q.questions[0];
      expect(first?.prompt).toBe("This swap is in your code. What's the story?");
      expect(first?.details[0]).toContain('made by your agent (Lovable)');
      expect(first?.options.map((o) => o.key)).toEqual(['a', 'k', 'g', 'x', 's']);
      questionId = first?.candidateId ?? '';
    });

    test('showing spends the budget', async () => {
      await post(`/api/candidates/${questionId}/shown`, {});
      const q = (await (await call(`/api/repos/${repo.id}/questions`)).json()) as QuestionsResponse;
      expect(q.budget.shownThisWeek).toBe(1);
    });

    test("'made' is refused on an agent's change: the API cannot blur the frame (G4)", async () => {
      const res = await post(`/api/candidates/${questionId}/answer`, {
        kind: 'decision',
        role: 'made',
        shape: { context: null, optionsConsidered: null, choice: 'x', cost: 'y', revisitCondition: null },
      });
      expect(res.status).toBe(400);
    });

    test("'kept' records a decision, the cost check runs, and a revision fixes it", async () => {
      const res = await post(`/api/candidates/${questionId}/answer`, {
        kind: 'decision',
        role: 'kept',
        shape: {
          context: '  ',
          optionsConsidered: null,
          choice: 'keep react-router-dom',
          cost: "it's slower",
          revisitCondition: '',
        },
      });
      const result = (await res.json()) as AnswerResponse;
      if (result.kind !== 'decision') throw new Error(`expected a decision, got ${result.kind}`);
      expect(result.verdict).toMatchObject({ namesLoss: false, systemSpecific: false });
      decisionId = result.decisionId;

      const revised = (await (
        await post(`/api/decisions/${decisionId}/revise`, {
          shape: {
            context: null,
            optionsConsidered: null,
            choice: 'keep react-router-dom',
            cost: 'I lost typed route params, so src/App.tsx parses ids by hand',
            revisitCondition: null,
          },
        })
      ).json()) as ReviseResponse;
      expect(revised.verdict).toMatchObject({ namesLoss: true, systemSpecific: true });
    });

    test('a second answer is a 409, not a second record', async () => {
      const res = await post(`/api/candidates/${questionId}/answer`, { kind: 'skip' });
      expect(res.status).toBe(409);
    });

    test('decisions list what is recorded and what is missing; blanks are stored as nothing', async () => {
      const list = (await (await call('/api/decisions')).json()) as DecisionsResponse;
      expect(list.decisions).toHaveLength(1);
      expect(list.decisions[0]).toMatchObject({ role: 'kept', context: null, revisitCondition: null });
      expect(list.decisions[0]?.missing).toEqual(['context', 'options considered', 'revisit condition']);
    });

    test('manual entry is a claim with an optional anchor', async () => {
      const res = await post(`/api/repos/${repo.id}/manual`, {
        shape: {
          context: null,
          optionsConsidered: 'SQLite',
          choice: 'Postgres over SQLite',
          cost: 'gave up zero-setup runs: src/App.tsx needs a server on 5432',
          revisitCondition: null,
        },
        anchor: { path: 'src/App.tsx' },
      });
      expect(res.status).toBe(201);
    });
  });
});
