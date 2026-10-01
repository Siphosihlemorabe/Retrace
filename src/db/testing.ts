/**
 * Database test plumbing.
 *
 * Tests read TEST_DATABASE_URL, never DATABASE_URL. 0002's tests seed a builder
 * user and write decisions; pointed at the real database they would mix fixture
 * rows into real ones, and their cleanup could delete real data. Two variables
 * cost one more line in .env and make that mistake impossible.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.js';
import type { Db } from './types.js';

export const testDatabaseUrl = process.env['TEST_DATABASE_URL'];

/**
 * For `describe.skipIf(...)`. Skipping is allowed locally, but under
 * `REQUIRE_DB=1` a missing database is a failure (guardrail G20) — a silent
 * skip once hid a migration that could not be applied at all.
 */
export function skipWithoutDatabase(): boolean {
  if (testDatabaseUrl) return false;
  if (process.env['REQUIRE_DB'] === '1') {
    throw new Error('REQUIRE_DB=1 but TEST_DATABASE_URL is not set');
  }
  return true;
}

/** A drizzle handle on the test database. The caller ends the pool. */
export async function openTestDb(): Promise<{ db: Db; pool: pg.Pool }> {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL not set');
  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * Drizzle wraps Postgres errors ("Failed query: …") and keeps the original on
 * `cause`, with the violated constraint's name. This reads both, so a test can
 * assert *which* guarantee refused a write.
 */
export async function rejectsWithConstraint(promise: Promise<unknown>, name: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as { message?: string; cause?: { message?: string; constraint?: string } };
    const text = [e.message, e.cause?.message, e.cause?.constraint].filter(Boolean).join(' | ');
    if (name.test(text)) return;
    throw new Error(`rejected, but not by ${String(name)}: ${text}`);
  }
  throw new Error(`expected the write to be rejected by ${String(name)}, but it succeeded`);
}
