import { and, eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { candidates, repos, users } from '../../db/schema.js';
import { openTestDb, skipWithoutDatabase } from '../../db/testing.js';
import type { Db } from '../../db/types.js';
import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import {
  fromCandidateRow,
  toCandidateRow,
  type CandidateRow,
} from '../detect/candidate-row.js';
import { DETECTOR_VERSION, type RankedCandidate } from '../detect/rank.js';
import { openRepo } from '../git/index.js';
import { persistCandidates } from './candidates.js';
import { ensureBuilder, registerLocalClone } from './local.js';

const SHA = 'e'.repeat(40);

function candidate(over: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    kind: 'replacement',
    packageName: 'react-router-dom',
    subjectKey: 'npm:react-router-dom',
    displaced: '@tanstack/react-router',
    category: 'router',
    categoryLabel: 'client router',
    sha: SHA,
    shortSha: SHA.slice(0, 7),
    date: new Date('2026-05-07T00:00:00Z'),
    subject: 'Changes',
    authorEmail: 'Bot@Example.com',
    filesInCommit: 91,
    commitIndex: 5,
    commitCount: 482,
    authorship: { authorship: 'agent', rule: 'known agent', actor: 'Lovable' },
    introducedAlone: false,
    looksScaffoldGenerated: true,
    importingFiles: 23,
    tests: {
      alternative: { pass: true, why: 'displaced @tanstack/react-router' },
      loadBearing: { pass: true, why: 'imported in 23 files' },
      deliberate: { pass: true, why: 'swap among 91 changed files, commit 5 of 482' },
    },
    score: 1,
    suppressed: null,
    suppressedDetail: null,
    ...over,
  };
}

const ctx = { repoId: 'r', userId: 'u', manifestPath: 'package.json' };

describe('candidate row mapping', () => {
  test('round-trips everything the ask screen shows', () => {
    const row = toCandidateRow(candidate(), ctx);
    const stored = fromCandidateRow({
      ...row,
      id: 'id',
      status: 'pending',
      skipCount: 0,
      detectedAt: new Date(),
    } as CandidateRow);

    expect(stored.kind).toBe('replacement');
    expect(stored.authorship).toEqual({ authorship: 'agent', rule: 'known agent', actor: 'Lovable' });
    expect(stored.authorEmail).toBe('bot@example.com');
    expect(stored.commitIndex).toBe(5);
    expect(stored.commitCount).toBe(482);
    expect(stored.score).toBe(1);
    expect(stored.signals.displaced).toBe('@tanstack/react-router');
    expect(stored.signals.tests.deliberate.why).toContain('commit 5 of 482');
    expect(row.displacedSubjectKey).toBe('npm:@tanstack/react-router');
    expect(row.detectorVersion).toBe(DETECTOR_VERSION);
    // Date-derived age is not written any more (G8).
    expect(row.projectAgeDaysAtIntroduction).toBeUndefined();
  });
});

describe.skipIf(skipWithoutDatabase())('persisting candidates', () => {
  let db: Db;
  let pool: pg.Pool;
  let fixture: FixtureRepo;
  let real: typeof ctx;

  beforeAll(async () => {
    ({ db, pool } = await openTestDb());
    fixture = await createFixtureRepo();
    await fixture.commit('root');
    const userId = await ensureBuilder(db, { githubUserId: 999000201, login: 'persist-test' });
    const clone = await registerLocalClone(db, await openRepo(fixture.dir));
    real = { repoId: clone.id, userId, manifestPath: 'package.json' };
  });

  afterAll(async () => {
    await db?.delete(repos).where(eq(repos.id, real.repoId));
    await db?.delete(users).where(eq(users.id, real.userId));
    await pool?.end();
    await fixture?.remove();
  });

  const rowsFor = () => db.select().from(candidates).where(eq(candidates.repoId, real.repoId));

  test('surfaced candidates are stored once; suppressed ones are not stored', async () => {
    const ranked = [
      candidate(),
      candidate({ subjectKey: 'npm:lodash', suppressed: 'no known alternative' }),
    ];
    expect(await persistCandidates(db, ranked, real)).toMatchObject({ inserted: 1, refreshed: 0 });
    expect(await persistCandidates(db, ranked, real)).toMatchObject({ inserted: 0, refreshed: 1 });
    expect(await rowsFor()).toHaveLength(1);
  });

  test('a pending row is refreshed with new authorship; an answered one is left alone', async () => {
    await persistCandidates(db, [candidate({ authorship: { authorship: 'builder', rule: 'r', actor: null } })], real);
    expect((await rowsFor())[0]?.introducedBy).toBe('builder');

    await db.update(candidates).set({ status: 'answered_decision' }).where(eq(candidates.repoId, real.repoId));
    const result = await persistCandidates(db, [candidate()], real);
    expect(result.alreadyAnswered).toBe(1);
    expect((await rowsFor())[0]?.introducedBy).toBe('builder');
  });

  test('answered at an older detector version means never asked again', async () => {
    await db.delete(candidates).where(eq(candidates.repoId, real.repoId));
    await db.insert(candidates).values({
      ...toCandidateRow(candidate(), real),
      detectorVersion: DETECTOR_VERSION - 1,
      status: 'dismissed',
      dismissedReason: 'not_my_choice',
    });

    const result = await persistCandidates(db, [candidate()], real);
    expect(result).toMatchObject({ inserted: 0, alreadyAnswered: 1 });
    expect(await rowsFor()).toHaveLength(1);
  });

  test('a pending candidate that stops surfacing is withdrawn: deleted if never shown, expired if shown', async () => {
    await db.delete(candidates).where(eq(candidates.repoId, real.repoId));
    const shown = candidate({ subjectKey: 'npm:zustand', kind: 'dependency_choice' });
    await persistCandidates(db, [candidate(), shown], real);
    await db
      .update(candidates)
      .set({ askedAt: new Date() })
      .where(and(eq(candidates.repoId, real.repoId), eq(candidates.subjectKey, 'npm:zustand')));

    // Both are now suppressed (say, identities showed they were a colleague's).
    const result = await persistCandidates(
      db,
      [candidate({ suppressed: 'someone else’s change' }), { ...shown, suppressed: 'someone else’s change' }],
      real,
    );
    expect(result.withdrawn).toBe(2);
    const rows = await rowsFor();
    expect(rows.map((r) => [r.subjectKey, r.status])).toEqual([['npm:zustand', 'expired']]);
  });
});
