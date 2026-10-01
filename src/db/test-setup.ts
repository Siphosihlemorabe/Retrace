/**
 * Vitest global setup: bring the test database up to the current migrations
 * before any test runs, so tests exercise the schema as it will actually be
 * deployed — the migrations, not `schema.ts`. Uses the same migrator and
 * journal as `npm run db:migrate`.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { testDatabaseUrl } from './testing.js';

export default async function setup(): Promise<void> {
  if (!testDatabaseUrl) return;
  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: 'migrations' });
  } finally {
    await pool.end();
  }
}
