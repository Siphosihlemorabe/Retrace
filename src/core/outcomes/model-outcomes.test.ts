/**
 * 0009 §3 against the test database and a fake provider: a list drafted for a
 * skill with no built-in one, reviewed and saved, then code found by the model
 * reading only the files its cues point at.
 */
import { and, eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { learningGoalOutcomes, learningGoals, outcomeSightings, repos, skillOutcomes, skills, users } from '../../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import { recordIdentity } from '../decisions/identity.js';
import { ensureBuilder, registerLocalClone } from '../decisions/local.js';
import { openRepo } from '../git/index.js';
import type { Provider } from '../llm/index.js';
import { loadCoverage } from './coverage.js';
import { draftOutcomes, saveOutcomeList } from './draft.js';
import { setGoals } from './goals.js';
import { modelScan } from './model-scan.js';
import type { ScanScope } from './scan.js';

const ME = { name: 'Me', email: 'model-outcomes-me@example.com' };
const AGENT = { name: 'gpt-engineer-app[bot]', email: '159125892+gpt-engineer-app[bot]@users.noreply.github.com' };

const DRAFT = {
  outcomes: [
    { name: 'Caching with TTLs', description: 'Store values that expire on their own', lookFor: ['EX:', 'setex', 'expire('] },
    { name: 'Cache invalidation', description: 'Remove or update cached values when the source changes', lookFor: ['.del('] },
    { name: 'Pub/Sub', description: 'Send messages between processes through channels', lookFor: ['publish(', 'subscribe('] },
    { name: 'Streams', description: 'Append-only logs read by consumer groups', lookFor: ['xadd', 'xreadgroup'] },
    { name: 'Transactions', description: 'Group commands so they apply together', lookFor: ['multi(', '.exec('] },
    { name: 'Persistence', description: 'Choose how and whether data survives a restart', lookFor: ['appendonly', 'save '] },
  ],
};

/** A provider that drafts the list, and finds hits by file name: including two it must not be trusted on. */
function fake(): Provider & { calls: string[] } {
  const p = {
    name: 'claude-cli' as const,
    sendsCodeOffMachine: true,
    model: 'fake-model',
    calls: [] as string[],
    async complete({ input }: { system: string; input: string }) {
      const file = /^File: (.+)$/m.exec(input)?.[1] ?? 'draft';
      p.calls.push(file);
      const replies: Record<string, unknown> = {
        draft: DRAFT,
        'src/cache.ts': { hits: [{ outcome: 'keydb.caching-with-ttls', lines: [2, 2] }] },
        'src/invalidate.ts': {
          hits: [
            { outcome: 'keydb.cache-invalidation', lines: [2, 2] },
            { outcome: 'keydb.not-on-the-list', lines: [2, 2] },
            { outcome: 'keydb.cache-invalidation', lines: [90, 95] },
          ],
        },
      };
      return { text: JSON.stringify(replies[file] ?? { hits: [] }), model: 'fake-model' };
    },
  };
  return p;
}

describe.skipIf(skipWithoutDatabase())('outcome lists for any skill', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let scope: ScanScope;
  let skillId: string;

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.write('.gitignore', 'node_modules\n');
    await fixture.commit('initial', { author: ME });
    // Before the goal: the agent caches with a TTL.
    await fixture.write('src/cache.ts', "export async function put(client, key, v) {\n  await client.set(key, v, { EX: 60 });\n}\n");
    await fixture.write('src/plain.ts', 'export const add = (a: number, b: number) => a + b;\n');
    await fixture.write('README.md', 'Uses EX: 60 for the cache.\n');
    await fixture.commit('Changes', { author: AGENT });

    const userId = await ensureBuilder(db, { githubUserId: 999000921, login: 'model-outcomes' });
    await recordIdentity(db, userId, ME, 'me');
    const repo = await openRepo(fixture.dir);
    const clone = await registerLocalClone(db, repo);
    scope = { db, userId, repo, repoId: clone.id };
  }, 60_000);

  afterAll(async () => {
    if (scope !== undefined) {
      await db.delete(repos).where(eq(repos.id, scope.repoId));
      await db.delete(users).where(eq(users.id, scope.userId));
    }
    if (skillId !== undefined) await db.delete(skills).where(eq(skills.id, skillId));
    await pool?.end();
    await fixture?.remove();
  });

  test('a goal for a skill with no list waits for one; the draft saves nothing', async () => {
    const set = await setGoals(scope, [{ name: 'KeyDB', objective: 'all' }]);
    expect(set.goals[0]).toMatchObject({ skill: 'keydb', hasOutcomeList: false });

    const draft = await draftOutcomes(db, scope.userId, 'KeyDB', fake());
    expect(draft.ok && draft.value.outcomes).toHaveLength(6);
    const [cov] = await loadCoverage(db, scope.userId, scope.repoId);
    expect(cov?.outcomes).toHaveLength(0);
  });

  test('the reviewed list is saved as the builder’s, and joins the goal’s objective', async () => {
    const [cov0] = await loadCoverage(db, scope.userId, scope.repoId);
    // The builder drops Persistence and renames one.
    const reviewed = DRAFT.outcomes.filter((o) => o.name !== 'Persistence').map((o) => (o.name === 'Streams' ? { ...o, name: 'Redis Streams' } : o));
    const [goal] = await db.select({ skillId: learningGoals.skillId }).from(learningGoals).where(eq(learningGoals.id, cov0!.goalId));
    skillId = goal!.skillId!;
    const saved = await saveOutcomeList(db, skillId, reviewed);
    expect(saved).toMatchObject({ added: 5, retired: 0 });
    expect(saved.slugs).toContain('keydb.redis-streams');

    const rows = await db.select().from(skillOutcomes).where(eq(skillOutcomes.skillId, skillId));
    expect(rows.every((r) => r.source === 'model_reviewed')).toBe(true);
    const ticked = await db.select().from(learningGoalOutcomes).where(eq(learningGoalOutcomes.goalId, cov0!.goalId));
    expect(ticked.filter((t) => t.inObjective)).toHaveLength(5);

    // Saving again with one removed retires it and ticks nothing new.
    const again = await saveOutcomeList(db, skillId, reviewed.filter((o) => o.name !== 'Transactions'));
    expect(again).toMatchObject({ added: 0, retired: 1 });
    // A retired outcome leaves the denominator too.
    const [cov1] = await loadCoverage(db, scope.userId, scope.repoId);
    expect(cov1).toMatchObject({ total: 4, modelList: true });
    await saveOutcomeList(db, skillId, reviewed);
    expect((await loadCoverage(db, scope.userId, scope.repoId))[0]?.total).toBe(5);
  });

  test('no code leaves the machine before consent', async () => {
    const p = fake();
    const r = await modelScan({ ...scope, llmAllowed: false }, skillId, p);
    expect(r).toMatchObject({ ok: false, reason: 'no_consent' });
    expect(p.calls).toHaveLength(0);
  });

  test('only files whose cues match are read, and only hits on shown lines and listed outcomes are kept', async () => {
    // After the goal: the builder invalidates on write.
    await fixture.write('src/invalidate.ts', "export async function onWrite(client, key) {\n  await client.del(key);\n}\n");
    await fixture.commit('invalidate on write', { day: 2, author: ME });

    const p = fake();
    const r = await modelScan({ ...scope, llmAllowed: true }, skillId, p);
    // Not plain.ts (no cue), not README.md (not code or config).
    expect(p.calls.sort()).toEqual(['src/cache.ts', 'src/invalidate.ts']);
    expect(r).toMatchObject({ ok: true, candidates: 2, read: 2, sightings: 2, stopped: null });

    const found = await db
      .select()
      .from(outcomeSightings)
      .where(and(eq(outcomeSightings.repoId, scope.repoId), eq(outcomeSightings.foundBy, 'model')));
    const byPath = Object.fromEntries(found.map((s) => [s.path, s]));
    expect(byPath['src/cache.ts']).toMatchObject({ authorship: 'agent', writtenAfterGoal: false, lineStart: 2 });
    expect(byPath['src/invalidate.ts']).toMatchObject({ authorship: 'builder', writtenAfterGoal: true, lineStart: 2 });

    const [cov] = await loadCoverage(db, scope.userId, scope.repoId);
    const inv = cov?.outcomes.find((o) => o.slug === 'keydb.cache-invalidation');
    expect(inv?.sightings[0]).toMatchObject({ foundBy: 'model', when: 'after_goal', authorship: 'builder' });
  });

  test('unchanged files are not read again, nor recorded again at a later HEAD', async () => {
    await fixture.write('src/plain.ts', 'export const add = (a: number, b: number) => a + b + 0;\n');
    await fixture.commit('tweak', { day: 3, author: ME });
    const p = fake();
    const r = await modelScan({ ...scope, llmAllowed: true }, skillId, p);
    expect(p.calls).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, read: 0, cached: 2, sightings: 0 });
  });

  test('a run stops at its limit and says so', async () => {
    await db.delete(outcomeSightings).where(eq(outcomeSightings.repoId, scope.repoId));
    await fixture.write('src/cache.ts', "export async function put(client, key, v) {\n  await client.set(key, v, { EX: 120 });\n}\n");
    await fixture.write('src/invalidate.ts', "export async function onWrite(client, key) {\n  await client.del(key); // now\n}\n");
    await fixture.commit('longer ttl', { day: 4, author: ME });
    const r = await modelScan({ ...scope, llmAllowed: true }, skillId, fake(), { maxCalls: 1 });
    expect(r).toMatchObject({ ok: true, read: 1, stopped: 'run_limit' });
  });
});
