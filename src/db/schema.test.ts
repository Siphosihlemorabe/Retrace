/**
 * Proves the guarantees the schema is supposed to make, rather than the columns
 * it happens to have. Each test maps to a claim the product makes to a user.
 *
 * Needs a live database:  TEST_DATABASE_URL=... npm test (migrated by test-setup.ts)
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { skipWithoutDatabase, testDatabaseUrl } from './testing.js';

const connectionString = testDatabaseUrl;

const db = connectionString ? new pg.Pool({ connectionString }) : null;
const q = async (text: string, values: unknown[] = []) => {
  if (!db) throw new Error('TEST_DATABASE_URL not set');
  return db.query(text, values);
};

/** Asserts a statement is rejected, and returns the error for inspection. */
const mustFail = async (text: string, values: unknown[] = []) => {
  try {
    await q(text, values);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`expected failure, but the statement succeeded: ${text}`);
};

describe.skipIf(skipWithoutDatabase())('schema guarantees', () => {
  let userId: string;
  let repoId: string;

  beforeAll(async () => {
    const user = await q(
      `INSERT INTO users (github_user_id, login) VALUES ($1, $2) RETURNING id`,
      [999000001, 'schema-test'],
    );
    userId = user.rows[0].id;

    const installation = await q(
      `INSERT INTO installations (github_installation_id, account_login, account_type, user_id)
       VALUES ($1, 'schema-test', 'User', $2) RETURNING id`,
      [999000001, userId],
    );

    const repo = await q(
      `INSERT INTO repos (installation_id, github_repo_id, owner, name, is_private, default_branch)
       VALUES ($1, $2, 'schema-test', 'fixture', false, 'main') RETURNING id`,
      [installation.rows[0].id, 999000001],
    );
    repoId = repo.rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    // repos cascade-delete their sightings; the no-direct-delete trigger allows
    // that path by design. Order matters: repo first, then user.
    await db.query(`DELETE FROM repos WHERE id = $1`, [repoId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    // Skills are shared, not user-owned, so the cascade above misses this one
    // and a second run would fail on the unique slug.
    await db.query(`DELETE FROM skills WHERE slug = 'fixture-skill'`);
    await db.end();
  });

  // The whole verification claim rests on this one being true.
  test('first_seen_at cannot be rewritten', async () => {
    const sha = 'a'.repeat(40);
    await q(
      `INSERT INTO commit_sightings (repo_id, sha, source) VALUES ($1, $2, 'webhook')`,
      [repoId, sha],
    );

    const error = await mustFail(
      `UPDATE commit_sightings SET first_seen_at = now() WHERE repo_id = $1 AND sha = $2`,
      [repoId, sha],
    );
    expect(error.message).toMatch(/append-only/);

    const error2 = await mustFail(
      `DELETE FROM commit_sightings WHERE repo_id = $1 AND sha = $2`,
      [repoId, sha],
    );
    expect(error2.message).toMatch(/disconnecting their repo/);
  });

  test('evidence attaches to exactly one thing', async () => {
    const claim = await q(
      // A data-modifying statement is only allowed in a WITH, not a subquery.
      `WITH s AS (
         INSERT INTO skills (slug, name, kind) VALUES ('fixture-skill', 'Fixture', 'technology')
         RETURNING id
       )
       INSERT INTO skill_claims (user_id, skill_id, level_ordinal)
       SELECT $1, s.id, 1 FROM s RETURNING id`,
      [userId],
    );
    const claimId = claim.rows[0].id;

    const goal = await q(
      `INSERT INTO learning_goals (user_id, title) VALUES ($1, 'fixture') RETURNING id`,
      [userId],
    );

    // Neither target set.
    await mustFail(
      `INSERT INTO evidence (user_id, sha, kind) VALUES ($1, $2, 'config')`,
      [userId, 'b'.repeat(40)],
    );

    // Two targets set.
    await mustFail(
      `INSERT INTO evidence (user_id, sha, kind, skill_claim_id, learning_goal_id)
       VALUES ($1, $2, 'config', $3, $4)`,
      [userId, 'b'.repeat(40), claimId, goal.rows[0].id],
    );

    // Exactly one.
    const ok = await q(
      `INSERT INTO evidence (user_id, sha, kind, skill_claim_id)
       VALUES ($1, $2, 'config', $3) RETURNING id`,
      [userId, 'b'.repeat(40), claimId],
    );
    expect(ok.rows).toHaveLength(1);
  });

  // "Verified should mean still checkable." A broken pointer has to survive as a
  // claim — deleting it would make the profile look better than it is.
  test('broken evidence is kept and stops counting as verified', async () => {
    const claim = await q(
      `SELECT id FROM skill_claims WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    const claimId = claim.rows[0].id;

    await q(`SELECT recompute_skill_claim_status($1)`, [claimId]);
    let status = await q(`SELECT status FROM skill_claims WHERE id = $1`, [claimId]);
    expect(status.rows[0].status).toBe('verified');

    await q(
      `UPDATE evidence SET verification_status = 'broken', broken_reason = 'history_rewritten',
              broken_at = now() WHERE skill_claim_id = $1`,
      [claimId],
    );
    await q(`SELECT recompute_skill_claim_status($1)`, [claimId]);

    status = await q(`SELECT status FROM skill_claims WHERE id = $1`, [claimId]);
    expect(status.rows[0].status).toBe('claimed');

    // Still there. Dropping back to a claim is the point; vanishing is not.
    const surviving = await q(
      `SELECT count(*)::int AS n FROM evidence WHERE skill_claim_id = $1`,
      [claimId],
    );
    expect(surviving.rows[0].n).toBe(1);
  });

  test('re-running detection does not duplicate candidates', async () => {
    const insert = `
      INSERT INTO candidates (repo_id, user_id, kind, subject_kind, subject_key,
                              introducing_sha, detector_version)
      VALUES ($1, $2, 'dependency_choice', 'dependency', 'npm:prisma', $3, 1)`;
    await q(insert, [repoId, userId, 'c'.repeat(40)]);
    const error = await mustFail(insert, [repoId, userId, 'c'.repeat(40)]);
    expect(error.message).toMatch(/candidates_dedupe_unq/);
  });

  test('dismissal reasons stay mapped to the three tests', async () => {
    const error = await mustFail(
      `UPDATE candidates SET status = 'dismissed', dismissed_reason = 'meh' WHERE repo_id = $1`,
      [repoId],
    );
    expect(error.message).toMatch(/candidates_dismissed_reason/);
  });

  test('the ask-budget index exists', async () => {
    // Asserting the index exists, not that the planner picks it: on a table this
    // small a seq scan is correct, so an EXPLAIN assertion would fail for the
    // wrong reason. Re-check the plan against real data volume.
    const result = await q(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'candidates_ask_budget_idx'`,
    );
    expect(result.rows[0]?.indexdef).toMatch(/WHERE \(status = 'pending'/);
  });

  // The one constraint CLAUDE.md says must survive: matching has to be possible
  // later. If this query needs a table that does not exist, the schema is wrong
  // and now is when it is cheap to find out.
  test('a job spec can be scored against verified claims, with no new tables', async () => {
    const spec = [
      { skill: 'PostgreSQL', minLevel: 1 },
      { skill: 'fixture-skill', minLevel: 1 },
    ];

    const result = await q(
      `WITH spec(alias, min_level) AS (SELECT * FROM unnest($1::text[], $2::int[]))
       SELECT spec.alias,
              coalesce(max(c.level_ordinal), 0) AS attained,
              coalesce(max(c.level_ordinal), 0) >= spec.min_level AS meets
       FROM spec
       LEFT JOIN skill_aliases a ON a.alias = spec.alias
       LEFT JOIN skills s ON s.id = a.skill_id
       LEFT JOIN skill_claims c
              ON c.skill_id = s.id AND c.user_id = $3 AND c.status = 'verified'
       GROUP BY spec.alias, spec.min_level
       ORDER BY spec.alias`,
      [spec.map((s) => s.skill), spec.map((s) => s.minLevel), userId],
    );

    expect(result.rows).toHaveLength(2);
    // Nothing is verified for this fixture user, so nothing should match.
    // The assertion that matters is that the query runs at all.
    expect(result.rows.every((r) => r.meets === false)).toBe(true);
  });
});
