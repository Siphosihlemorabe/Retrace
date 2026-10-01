/**
 * The 0009 routes end to end with no model connected (RETRACE_LLM=off): this
 * week's questions, showing, answering, skipping, settings, consent, and
 * saving an outcome list for a skill with no built-in one.
 */
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { recordIdentity } from '../core/decisions/identity.js';
import { ensureBuilder, registerLocalClone } from '../core/decisions/local.js';
import { openRepo } from '../core/git/index.js';
import { repos, skills, users } from '../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../db/testing.js';
import type { Db } from '../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../test/fixture-repo.js';
import type { DraftOutcomesResponse, LlmStatusResponse, ModelScanResponse, SavedOutcomesResponse, SkipResponse, WeekResponse } from './api-types.js';
import { createApp } from './app.js';

const ME = { name: 'Me', email: 'questions-api-me@example.com' };

describe.skipIf(skipWithoutDatabase())('questions API', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let userId: string;
  let repoId: string;
  let app: ReturnType<typeof createApp>;
  const saved = new Map<string, string | undefined>();

  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { host: '127.0.0.1:3000', 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const send = (method: string, path: string, payload: unknown) => call(path, { method, body: JSON.stringify(payload) });
  const week = async () => (await (await call(`/api/repos/${repoId}/week`)).json()) as WeekResponse;

  beforeAll(async () => {
    saved.set('RETRACE_LLM', process.env['RETRACE_LLM']);
    process.env['RETRACE_LLM'] = 'off';
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.write('README.md', '# app\n');
    await fixture.commit('initial', { author: ME });
    userId = await ensureBuilder(db, { githubUserId: 999000931, login: 'questions-api' });
    await recordIdentity(db, userId, ME, 'me');
    repoId = (await registerLocalClone(db, await openRepo(fixture.dir))).id;
    app = createApp({ db, userId, login: 'questions-api' });

    await send('POST', `/api/repos/${repoId}/goals`, { goals: [{ name: 'SQL', objective: ['sql.joins'] }, { name: 'Memcachedx', objective: 'all' }] });
    await fixture.write('db/report.sql', 'SELECT o.id, c.name\nFROM orders o\nLEFT JOIN customers c ON c.id = o.customer_id;\n');
    await fixture.commit('report', { day: 1, author: ME });
    await send('POST', `/api/repos/${repoId}/scan`, {});
  }, 60_000);

  afterAll(async () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (repoId !== undefined) await db?.delete(repos).where(eq(repos.id, repoId));
    await db?.delete(users).where(eq(users.id, userId));
    await db?.delete(skills).where(eq(skills.slug, 'memcachedx'));
    await pool?.end();
    await fixture?.remove();
  });

  test('status says no model is connected, and the weekly number', async () => {
    const s = (await (await call('/api/llm')).json()) as LlmStatusResponse;
    expect(s).toMatchObject({ provider: 'off', sendsCodeOffMachine: false, questionsPerWeek: 3 });
  });

  test('this week’s questions come with their code, and never with key points', async () => {
    const w = await week();
    expect(w.budget).toMatchObject({ limit: 3, remaining: 3 });
    const first = w.questions[0];
    expect(first).toMatchObject({ kind: 'outcome_sighting', foundBy: 'rule', shown: false });
    expect(first?.code).toMatchObject({ path: 'db/report.sql', authorship: 'builder' });
    expect(first?.code?.excerpt.some((l) => l.text.includes('LEFT JOIN'))).toBe(true);
    expect(JSON.stringify(w)).not.toMatch(/keyPoints/);
  });

  test('shown, answered, skipped', async () => {
    const [q, other] = (await week()).questions;
    expect((await call(`/api/questions/${q!.id}/shown`, { method: 'POST' })).status).toBe(200);
    expect((await week()).budget.remaining).toBe(2);

    expect((await send('POST', `/api/questions/${q!.id}/answer`, { answer: '' })).status).toBe(400);
    expect((await send('POST', `/api/questions/${q!.id}/answer`, { answer: 'Orders with a deleted customer still show, with no name.' })).status).toBe(200);
    expect((await send('POST', `/api/questions/${q!.id}/answer`, { answer: 'again' })).status).toBe(409);

    if (other !== undefined) {
      const skip = (await (await call(`/api/questions/${other.id}/skip`, { method: 'POST' })).json()) as SkipResponse;
      expect(skip.status).toBe('pending');
    }
    expect((await call('/api/questions/00000000-0000-4000-8000-000000000000/skip', { method: 'POST' })).status).toBe(404);
  });

  test('settings keep the floor of three', async () => {
    expect((await send('PUT', '/api/settings', { questionsPerWeek: 2 })).status).toBe(400);
    expect((await send('PUT', '/api/settings', { questionsPerWeek: 4 })).status).toBe(200);
    expect(((await (await call('/api/llm')).json()) as LlmStatusResponse).questionsPerWeek).toBe(4);
  });

  test('a skill with no list: no draft without a model, but the builder can save their own', async () => {
    const draft = (await (await call('/api/skills/memcachedx/draft', { method: 'POST' })).json()) as DraftOutcomesResponse;
    expect(draft).toMatchObject({ outcomes: null, reason: 'off' });

    const list = [{ name: 'Expiry', description: 'Values that expire on their own', lookFor: ['expire'] }];
    const res = await send('PUT', '/api/skills/memcachedx/outcomes', { outcomes: list });
    expect(((await res.json()) as SavedOutcomesResponse).added).toBe(1);
    // A built-in list can't be replaced.
    expect((await send('PUT', '/api/skills/sql/outcomes', { outcomes: list })).status).toBe(400);

    const scan = (await (await send('POST', `/api/repos/${repoId}/model-scan`, { skill: 'memcachedx' })).json()) as ModelScanResponse;
    expect(scan).toMatchObject({ ok: false, reason: 'off' });
  });

  test('consent is recorded per project', async () => {
    expect((await call(`/api/repos/${repoId}/llm-consent`, { method: 'POST' })).status).toBe(200);
    const [row] = await db.select({ at: repos.llmAllowedAt }).from(repos).where(eq(repos.id, repoId));
    expect(row?.at).toBeInstanceOf(Date);
  });
});
