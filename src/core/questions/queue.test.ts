/**
 * 0009's queue against the test database and a fake provider: the order
 * questions come in, the shared weekly budget, consent, falling back to a
 * rule-based question, and answering and skipping.
 */
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { practiceAnswers, repos, users } from '../../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import { recordIdentity } from '../decisions/identity.js';
import { ensureBuilder, registerLocalClone } from '../decisions/local.js';
import { openRepo } from '../git/index.js';
import type { Provider } from '../llm/index.js';
import { setGoals } from '../outcomes/goals.js';
import { scanNewCommits, type ScanScope } from '../outcomes/scan.js';
import { generate, type Target } from './generate.js';
import {
  allowModelForRepo,
  answerQuestion,
  markQuestionShown,
  nextQuestions,
  questionBudget,
  setQuestionsPerWeek,
  skipQuestion,
} from './queue.js';

const ME = { name: 'Me', email: 'queue-test-me@example.com' };
const AGENT = { name: 'gpt-engineer-app[bot]', email: '159125892+gpt-engineer-app[bot]@users.noreply.github.com' };

function fake(reply: unknown): Provider & { calls: number } {
  const p = {
    name: 'claude-cli' as const,
    sendsCodeOffMachine: true,
    model: 'fake-model',
    calls: 0,
    async complete() {
      p.calls += 1;
      return { text: JSON.stringify(reply), model: 'fake-model' };
    },
  };
  return p;
}

const good = {
  questions: [
    {
      text: 'What happens to orders whose customer row was deleted, given the join on line 3?',
      lines: [2, 3],
      keyPoints: [
        { point: 'LEFT JOIN keeps the order with a null name', lines: [3, 3] },
        { point: 'an inner join would drop it silently', lines: [3, 3] },
      ],
    },
  ],
};

describe.skipIf(skipWithoutDatabase())('the question queue', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let scope: ScanScope;

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.write('README.md', '# app\n');
    await fixture.commit('initial', { author: ME });
    // Before the goal: the agent writes a JOIN.
    await fixture.write('db/report.sql', 'SELECT o.id, c.name\nFROM orders o\nLEFT JOIN customers c ON c.id = o.customer_id;\n');
    await fixture.commit('Changes', { day: 1, author: AGENT });

    const userId = await ensureBuilder(db, { githubUserId: 999000911, login: 'queue-test' });
    await recordIdentity(db, userId, ME, 'me');
    const repo = await openRepo(fixture.dir);
    const clone = await registerLocalClone(db, repo);
    scope = { db, userId, repo, repoId: clone.id };

    await setGoals(scope, [{ name: 'SQL', objective: ['sql.joins', 'sql.aggregates', 'sql.indexes'] }]);
    // After the goal: the builder's own GROUP BY.
    await fixture.write('db/stats.sql', 'SELECT status, COUNT(*)\nFROM orders\nGROUP BY status;\n');
    await fixture.commit('stats', { day: 2, author: ME });
    await scanNewCommits(scope);
  }, 60_000);

  afterAll(async () => {
    if (scope !== undefined) {
      await db.delete(repos).where(eq(repos.id, scope.repoId));
      await db.delete(users).where(eq(users.id, scope.userId));
    }
    await pool?.end();
    await fixture?.remove();
  });

  test('without a model: your code first, then your agent’s, then what nothing touches yet', async () => {
    const qs = await nextQuestions(scope, null);
    expect(qs.map((q) => [q.targetKind, q.path, q.foundBy])).toEqual([
      ['outcome_sighting', 'db/stats.sql', 'rule'],
      ['outcome_sighting', 'db/report.sql', 'rule'],
      ['outcome_untouched', null, 'rule'],
    ]);
    expect(qs[0]?.text).toMatch(/^You wrote/);
    expect(qs[1]?.text).toMatch(/^Your agent wrote/);
  });

  test('a question spends the budget when shown, not when written', async () => {
    expect((await questionBudget(db, scope.userId)).remaining).toBe(3);
    const [first] = await nextQuestions(scope, null);
    await markQuestionShown(db, scope.userId, first!.id);
    await markQuestionShown(db, scope.userId, first!.id); // twice is still once
    expect(await questionBudget(db, scope.userId)).toMatchObject({ limit: 3, shownThisWeek: 1, remaining: 2 });
    // Asking again returns the same three, the shown one first, and writes nothing new.
    const again = await nextQuestions(scope, null);
    expect(again.map((q) => q.id)[0]).toBe(first!.id);
    expect(again).toHaveLength(3);
  });

  test('answers are stored as practice; skipping three times retires a question', async () => {
    const [shown, second] = await nextQuestions(scope, null);
    await answerQuestion(db, scope.userId, shown!.id, 'It groups orders by status and counts them; no index, so it scans.');
    const stored = await db.select().from(practiceAnswers).where(eq(practiceAnswers.questionId, shown!.id));
    expect(stored).toHaveLength(1);
    await expect(answerQuestion(db, scope.userId, shown!.id, 'again')).rejects.toThrow(/not open/);

    expect(await skipQuestion(db, scope.userId, second!.id)).toBe('pending');
    expect(await skipQuestion(db, scope.userId, second!.id)).toBe('pending');
    expect(await skipQuestion(db, scope.userId, second!.id)).toBe('expired');
    // An expired question's outcome is not asked about again this round.
    const left = await nextQuestions(scope, null);
    expect(left.map((q) => q.id)).not.toContain(second!.id);
    expect(left.every((q) => q.outcomeId !== second!.outcomeId)).toBe(true);
  });

  test('the weekly number has a floor of three', async () => {
    await expect(setQuestionsPerWeek(db, scope.userId, 2)).rejects.toThrow(/At least 3/);
    await setQuestionsPerWeek(db, scope.userId, 5);
    expect((await questionBudget(db, scope.userId)).limit).toBe(5);
  });
});

describe.skipIf(skipWithoutDatabase())('generating one question', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let scope: ScanScope;
  let target: Extract<Target, { kind: 'outcome_sighting' }>;

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.write('db/report.sql', 'SELECT o.id, c.name\nFROM orders o\nLEFT JOIN customers c ON c.id = o.customer_id;\n');
    const sha = await fixture.commit('Changes', { author: AGENT });
    const userId = await ensureBuilder(db, { githubUserId: 999000912, login: 'generate-test' });
    const repo = await openRepo(fixture.dir);
    const clone = await registerLocalClone(db, repo);
    scope = { db, userId, repo, repoId: clone.id };
    target = {
      kind: 'outcome_sighting',
      sightingId: 'not-stored',
      outcomeId: 'sql.joins',
      outcome: { name: 'Joins', description: 'Combine rows from two tables', skill: 'SQL' },
      sha,
      path: 'db/report.sql',
      lineStart: 3,
      lineEnd: 3,
      authorship: 'agent',
      inObjective: true,
    };
  }, 60_000);

  afterAll(async () => {
    if (scope !== undefined) {
      await db.delete(repos).where(eq(repos.id, scope.repoId));
      await db.delete(users).where(eq(users.id, scope.userId));
    }
    await pool?.end();
    await fixture?.remove();
  });

  test('no code leaves the machine before consent', async () => {
    const p = fake(good);
    const g = await generate({ ...scope, llmAllowed: false }, target, p);
    expect(g).toMatchObject({ foundBy: 'rule', fallbackReason: 'no_consent', lines: [3, 3] });
    expect(p.calls).toBe(0);
  });

  test('with consent, the model’s question and key points are kept, and cached', async () => {
    await allowModelForRepo(db, scope.repoId);
    const p = fake(good);
    const g = await generate({ ...scope, llmAllowed: true }, target, p);
    expect(g).toMatchObject({ foundBy: 'model', lines: [2, 3], provider: 'claude-cli', fallbackReason: null });
    expect(g.keyPoints).toHaveLength(2);
    await generate({ ...scope, llmAllowed: true }, target, p);
    expect(p.calls).toBe(1);
  });

  test('a question about lines the model was never shown falls back to the rule', async () => {
    const p = fake({ questions: [{ ...good.questions[0], lines: [40, 42] }] });
    const g = await generate({ ...scope, llmAllowed: true }, { ...target, lineStart: 2, lineEnd: 2 }, p);
    expect(g).toMatchObject({ foundBy: 'rule', fallbackReason: 'failed' });
  });
});
