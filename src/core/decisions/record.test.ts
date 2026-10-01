import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  candidates,
  decisionRevisions,
  decisions,
  learningGoals,
  repos,
  users,
} from '../../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import { fromCandidateRow, toCandidateRow, type StoredCandidate } from '../detect/candidate-row.js';
import type { RankedCandidate } from '../detect/rank.js';
import { openRepo } from '../git/index.js';
import { checkCost } from './cost-check.js';
import { ensureBuilder, registerLocalClone } from './local.js';
import {
  dismissCandidate,
  recordDecision,
  recordLearningGoal,
  reviseDecision,
  type DecisionShape,
} from './record.js';

const ranked: RankedCandidate = {
  kind: 'replacement',
  packageName: 'react-router-dom',
  subjectKey: 'npm:react-router-dom',
  displaced: '@tanstack/react-router',
  category: 'router',
  categoryLabel: 'client router',
  sha: 'a1'.repeat(20),
  shortSha: 'a1a1a1a',
  date: new Date(),
  subject: 'Changes',
  authorEmail: 'bot@example.com',
  filesInCommit: 91,
  commitIndex: 5,
  commitCount: 482,
  authorship: { authorship: 'agent', rule: 'known agent', actor: 'Lovable' },
  introducedAlone: false,
  looksScaffoldGenerated: true,
  importingFiles: 23,
  tests: {
    alternative: { pass: true, why: '' },
    loadBearing: { pass: true, why: '' },
    deliberate: { pass: true, why: '' },
  },
  score: 1,
  suppressed: null,
  suppressedDetail: null,
};

const costCtx = {
  choice: 'react-router-dom',
  alternative: '@tanstack/react-router',
  packageNames: ['react-router-dom', 'zod'],
  paths: ['src/routes/booking.tsx'],
};

const shape = (cost: string): DecisionShape => ({
  context: null,
  optionsConsidered: null,
  choice: 'keep react-router-dom',
  cost,
  revisitCondition: null,
});

describe.skipIf(skipWithoutDatabase())('recording answers', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let userId: string;
  let repoId: string;
  let candidate: StoredCandidate;

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.commit('root');
    userId = await ensureBuilder(db, { githubUserId: 999000401, login: 'record-test' });
    repoId = (await registerLocalClone(db, await openRepo(fixture.dir))).id;
  });

  beforeEach(async () => {
    await db.delete(decisions).where(eq(decisions.userId, userId));
    await db.delete(learningGoals).where(eq(learningGoals.userId, userId));
    await db.delete(candidates).where(eq(candidates.repoId, repoId));
    const [row] = await db
      .insert(candidates)
      .values(toCandidateRow(ranked, { repoId, userId, manifestPath: 'package.json' }))
      .returning();
    if (row === undefined) throw new Error('seed failed');
    candidate = fromCandidateRow(row);
  });

  afterAll(async () => {
    await db?.delete(repos).where(eq(repos.id, repoId));
    await db?.delete(users).where(eq(users.id, userId));
    await pool?.end();
    await fixture?.remove();
  });

  const statusOf = async () =>
    (await db.select().from(candidates).where(eq(candidates.id, candidate.id)))[0];

  test("'kept' an agent's choice: decision anchored to the candidate, candidate answered", async () => {
    const id = await recordDecision(db, {
      userId,
      repoId,
      candidate,
      role: 'kept',
      shape: shape("it's slower"),
      verdict: checkCost("it's slower", costCtx),
    });

    const [d] = await db.select().from(decisions).where(eq(decisions.id, id));
    expect(d).toMatchObject({
      role: 'kept',
      origin: 'prompted_by_detection',
      anchorSha: candidate.introducingSha,
      anchorPath: 'package.json',
      provenance: 'retrospective',
      costNamesLoss: false,
      costCheckVersion: 1,
    });
    expect(d?.costFeedback).toMatch(/slower/);
    expect(await statusOf()).toMatchObject({ status: 'answered_decision', authorshipDisputedAt: null });
  });

  test("'[a] I asked for it' records the authorship dispute in the same transaction", async () => {
    await recordDecision(db, { userId, repoId, candidate, role: 'directed', shape: shape('x'), verdict: null });
    expect((await statusOf())?.authorshipDisputedAt).toBeInstanceOf(Date);
  });

  test('a candidate can only be answered once; the second answer leaves no residue', async () => {
    await recordDecision(db, { userId, repoId, candidate, role: 'kept', shape: shape('x'), verdict: null });
    await expect(
      recordDecision(db, { userId, repoId, candidate, role: 'made', shape: shape('y'), verdict: null }),
    ).rejects.toThrow(/not pending/);
    // The failed answer's decision row was rolled back with it.
    expect(await db.select().from(decisions).where(eq(decisions.userId, userId))).toHaveLength(1);
  });

  test('every edit keeps the prior version, numbered', async () => {
    const id = await recordDecision(db, {
      userId,
      repoId,
      candidate,
      role: 'kept',
      shape: shape("it's slower"),
      verdict: checkCost("it's slower", costCtx),
    });
    const better = 'I lost typed route params, so src/routes/booking.tsx parses ids by hand';
    expect(await reviseDecision(db, id, shape(better), checkCost(better, costCtx))).toBe(1);
    expect(await reviseDecision(db, id, shape(`${better}.`), checkCost(better, costCtx))).toBe(2);

    const revisions = await db
      .select()
      .from(decisionRevisions)
      .where(eq(decisionRevisions.decisionId, id))
      .orderBy(decisionRevisions.revisionNo);
    expect(revisions.map((r) => r.cost)).toEqual(["it's slower", better]);

    const [d] = await db.select().from(decisions).where(eq(decisions.id, id));
    expect(d).toMatchObject({ cost: `${better}.`, costNamesLoss: true, costIsSystemSpecific: true, role: 'kept' });
  });

  test("'[g]' is a learning goal tied to its candidate", async () => {
    await recordLearningGoal(db, {
      userId,
      candidate,
      title: 'What changed when the router was swapped',
      note: 'why loaders went away',
    });
    const goals = await db.select().from(learningGoals).where(eq(learningGoals.userId, userId));
    expect(goals).toMatchObject([{ candidateId: candidate.id, status: 'open' }]);
    expect((await statusOf())?.status).toBe('answered_gap');
  });

  test('a dismissal keeps its reason, mapped to the three tests', async () => {
    await dismissCandidate(db, candidate.id, 'not_load_bearing', 'one import, easily swapped');
    expect(await statusOf()).toMatchObject({
      status: 'dismissed',
      dismissedReason: 'not_load_bearing',
      dismissedNote: 'one import, easily swapped',
    });
  });

  test('manual entry is a claim with its own anchor and no candidate', async () => {
    const id = await recordDecision(db, {
      userId,
      repoId,
      role: 'made',
      shape: shape('gave up SSR'),
      verdict: null,
      anchor: { sha: 'b2'.repeat(20), path: 'src/main.tsx' },
    });
    const [d] = await db.select().from(decisions).where(eq(decisions.id, id));
    expect(d).toMatchObject({ origin: 'entered_manually', candidateId: null, anchorPath: 'src/main.tsx' });
  });
});
