/**
 * Database test plumbing.
 *
 * Tests read TEST_DATABASE_URL, never DATABASE_URL. 0002's tests seed a builder
 * user and write decisions; pointed at the real database they would mix fixture
 * rows into real ones, and their cleanup could delete real data. Two variables
 * cost one more line in .env and make that mistake impossible.
 */
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
