/**
 * The 0007 routes end to end: create a project, set goals, commit, scan, read
 * coverage, open the code view, relabel lines.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { recordIdentity } from '../core/decisions/identity.js';
import { ensureBuilder } from '../core/decisions/local.js';
import { repos, users } from '../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../db/testing.js';
import type { Db } from '../db/types.js';
import type { CodeViewResponse, CoverageResponse, RepoView, SetGoalsResponse } from './api-types.js';
import { createApp } from './app.js';

const exec = promisify(execFile);
const ME = { name: 'Api Goals Me', email: 'api-goals-me@example.com' };
const GIT_ENV = {
  GIT_AUTHOR_NAME: ME.name,
  GIT_AUTHOR_EMAIL: ME.email,
  GIT_COMMITTER_NAME: ME.name,
  GIT_COMMITTER_EMAIL: ME.email,
} as const;

describe.skipIf(skipWithoutDatabase())('goals API', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let parent: string;
  let app: ReturnType<typeof createApp>;
  let repo: RepoView;
  let joinSha: string;
  const saved = new Map<string, string | undefined>();

  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { host: '127.0.0.1:3000', 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const post = (path: string, payload: unknown) => call(path, { method: 'POST', body: JSON.stringify(payload) });

  beforeAll(async () => {
    for (const [k, v] of Object.entries(GIT_ENV)) {
      saved.set(k, process.env[k]);
      process.env[k] = v;
    }
    ({ db, pool } = await openTestDb());
    parent = await mkdtemp(join(tmpdir(), 'retrace-goals-api-'));
    userId = await ensureBuilder(db, { githubUserId: 999000901, login: 'goals-api' });
    await recordIdentity(db, userId, ME, 'me');
    app = createApp({ db, userId, login: 'goals-api' });
  });

  afterAll(async () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (repo !== undefined) await db?.delete(repos).where(eq(repos.id, repo.id));
    await db?.delete(users).where(eq(users.id, userId));
    await pool?.end();
    await rm(parent, { recursive: true, force: true });
  });

  test('lists the built-in skills and their outcomes', async () => {
    const res = (await (await call('/api/skills')).json()) as { skills: { slug: string; outcomes: unknown[] }[] };
    expect(res.skills.map((s) => s.slug)).toEqual(['sql', 'docker', 'node-rest-api']);
    expect(res.skills[0]?.outcomes).toHaveLength(11);
  });

  test('creates a new project, without GitHub unless asked', async () => {
    const res = await post('/api/projects', { path: join(parent, 'shop') });
    expect(res.status).toBe(201);
    repo = (await res.json()) as RepoView;
    expect(repo.name).toBe('shop');
  });

  test('sets goals before any code, then scans a commit and shows coverage', async () => {
    const set = (await (
      await post(`/api/repos/${repo.id}/goals`, { goals: [{ name: 'SQL', objective: ['sql.joins'] }] })
    ).json()) as SetGoalsResponse;
    expect(set.goals).toMatchObject([{ skill: 'sql', created: true, hasOutcomeList: true }]);

    await mkdir(join(repo.path, 'db'), { recursive: true });
    await writeFile(join(repo.path, 'db', 'q.sql'), 'SELECT o.id\nFROM orders o\nLEFT JOIN customers c ON c.id = o.cid;\n');
    await exec('git', ['-C', repo.path, 'add', '-A']);
    await exec('git', ['-C', repo.path, 'commit', '-m', 'orders query']);
    joinSha = (await exec('git', ['-C', repo.path, 'rev-parse', 'HEAD'])).stdout.trim();

    expect(((await (await post(`/api/repos/${repo.id}/scan`, {})).json()) as { commits: number }).commits).toBe(1);

    const cov = (await (await call(`/api/repos/${repo.id}/coverage`)).json()) as CoverageResponse;
    const sql = cov.goals[0];
    expect(sql).toMatchObject({ percentLearned: 0, total: 11, objective: { met: 0, total: 1 } });
    const joins = sql?.outcomes.find((o) => o.slug === 'sql.joins');
    expect(joins).toMatchObject({ status: 'touched', inObjective: true });
    expect(joins?.sightings[0]).toMatchObject({ authorship: 'builder', when: 'after_goal', path: 'db/q.sql' });
    expect(cov.positions[joinSha]).toBe(2);
  });

  test('the code view labels every line and highlights the touched range', async () => {
    const res = await call(`/api/repos/${repo.id}/code?sha=${joinSha}&path=${encodeURIComponent('db/q.sql')}`);
    const view = (await res.json()) as CodeViewResponse;
    expect(view.lines).toHaveLength(3);
    expect(view.lines.every((l) => l.authorship === 'builder')).toBe(true);
    expect(view.highlights).toContainEqual(expect.objectContaining({ start: 3, end: 3, outcome: 'sql.joins' }));
    expect(view.position).toBe(2);
  });

  test("relabelling lines as the agent's changes coverage at once", async () => {
    const res = await post(`/api/repos/${repo.id}/labels`, { sha: joinSha, path: 'db/q.sql', lineStart: 1, lineEnd: 3, label: 'agent' });
    expect(((await res.json()) as { updated: number }).updated).toBeGreaterThanOrEqual(1);
    const cov = (await (await call(`/api/repos/${repo.id}/coverage`)).json()) as CoverageResponse;
    expect(cov.goals[0]?.outcomes.find((o) => o.slug === 'sql.joins')?.sightings[0]?.authorship).toBe('agent');
    const view = (await (await call(`/api/repos/${repo.id}/code?sha=${joinSha}&path=db%2Fq.sql`)).json()) as CodeViewResponse;
    expect(view.lines[0]).toMatchObject({ authorship: 'agent', actor: 'you said', relabelled: true });
  });

  test('bad input is refused: a short SHA, a missing file, reversed lines', async () => {
    expect((await call(`/api/repos/${repo.id}/code?sha=abc&path=db/q.sql`)).status).toBe(400);
    expect((await call(`/api/repos/${repo.id}/code?sha=${joinSha}&path=nope.sql`)).status).toBe(404);
    expect((await post(`/api/repos/${repo.id}/labels`, { sha: joinSha, path: 'db/q.sql', lineStart: 3, lineEnd: 1, label: 'me' })).status).toBe(400);
    expect((await post('/api/projects', { path: repo.path })).status).toBe(400);
  });
});
