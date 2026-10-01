/**
 * The call path against a fake provider and the test database: cache, cap,
 * schema checks with one retry, and the call log.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';

import { analysisCache, llmCalls, users } from '../../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { ensureBuilder } from '../decisions/local.js';
import { completeJson, extractJson } from './index.js';
import type { Provider } from './providers.js';

const Schema = z.object({ answer: z.string() });

/** A provider that replies from a script, and counts its calls. */
function fake(replies: string[]): Provider & { calls: number } {
  const p = {
    name: 'claude-cli' as const,
    sendsCodeOffMachine: true,
    model: 'fake-model',
    calls: 0,
    async complete() {
      const text = replies[Math.min(p.calls, replies.length - 1)] ?? '';
      p.calls += 1;
      return { text, model: 'fake-model' };
    },
  };
  return p;
}

describe('extractJson', () => {
  test('reads plain, fenced, or surrounded JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":1} — hope that helps')).toEqual({ a: 1 });
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('only core/llm talks to a model (G15)', () => {
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const f = join(d, n);
      return statSync(f).isDirectory() ? files(f) : /\.tsx?$/.test(n) ? [f] : [];
    });
  test.each(files('src').filter((f) => !f.replace(/\\/g, '/').includes('src/core/llm/')))('%s', (f) => {
    const text = readFileSync(f, 'utf8');
    expect(text).not.toMatch(/from ['"]@anthropic-ai\/sdk/);
    expect(text).not.toMatch(/spawn\(\s*['"]claude/);
  });
});

describe.skipIf(skipWithoutDatabase())('completeJson', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let n = 0;
  const req = (over: Partial<Parameters<typeof completeJson>[2]> = {}) => ({
    purpose: 'test',
    promptVersion: 1,
    system: 'Return JSON.',
    input: 'Ask something.',
    schema: Schema,
    cacheParts: [`case-${n}`],
    ...over,
  });

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    userId = await ensureBuilder(db, { githubUserId: 999001201, login: 'llm-test' });
  });
  beforeEach(() => {
    n += 1;
    delete process.env['RETRACE_LLM_DAILY_CALLS'];
  });
  afterAll(async () => {
    await db?.delete(analysisCache).where(eq(analysisCache.kind, 'test'));
    await db?.delete(users).where(eq(users.id, userId));
    await pool?.end();
  });

  test('a valid reply is returned, cached and logged; the same request is then a cache hit', async () => {
    const p = fake(['{"answer":"yes"}']);
    const first = await completeJson(db, userId, req(), p);
    expect(first).toMatchObject({ ok: true, value: { answer: 'yes' }, cached: false });
    const second = await completeJson(db, userId, req(), p);
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(p.calls).toBe(1);
    const logged = await db.select().from(llmCalls).where(eq(llmCalls.userId, userId));
    expect(logged.filter((l) => l.cacheHit)).toHaveLength(1);
  });

  test('a prompt version bump misses the cache', async () => {
    const p = fake(['{"answer":"v1"}', '{"answer":"v2"}']);
    await completeJson(db, userId, req(), p);
    const bumped = await completeJson(db, userId, req({ promptVersion: 2 }), p);
    expect(bumped).toMatchObject({ ok: true, cached: false, value: { answer: 'v2' } });
    expect(p.calls).toBe(2);
  });

  test('a reply that does not fit is retried once, then refused rather than coerced (G16)', async () => {
    const fixed = fake(['{"wrong":1}', '{"answer":"second try"}']);
    expect(await completeJson(db, userId, req(), fixed)).toMatchObject({ ok: true, value: { answer: 'second try' } });

    n += 1;
    const broken = fake(['not json', '{"still":"wrong"}']);
    expect(await completeJson(db, userId, req(), broken)).toMatchObject({ ok: false, reason: 'failed' });
    expect(broken.calls).toBe(2);
  });

  test('the daily cap stops calls but not cache hits', async () => {
    const p = fake(['{"answer":"cached"}']);
    await completeJson(db, userId, req(), p);
    process.env['RETRACE_LLM_DAILY_CALLS'] = '0';
    expect(await completeJson(db, userId, req(), p)).toMatchObject({ ok: true, cached: true });
    n += 1;
    expect(await completeJson(db, userId, req(), p)).toMatchObject({ ok: false, reason: 'capped' });
  });

  test('RETRACE_LLM=off means no model at all', async () => {
    expect(await completeJson(db, userId, req(), null)).toMatchObject({ ok: false, reason: 'off' });
  });
});
