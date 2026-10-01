/**
 * What every database-backed entry point (CLI, local server) needs: a connection, and the builder.
 *
 * The builder is seeded from their real GitHub identity in .env
 * (RETRACE_GITHUB_USER_ID, RETRACE_GITHUB_LOGIN), so sign-in later finds this
 * row rather than creating a second one (0002).
 */
import { readFileSync } from 'node:fs';

import { ensureBuilder } from './core/decisions/local.js';
import type { Db } from './db/types.js';

export interface Session {
  db: Db;
  userId: string;
  end(): Promise<void>;
}

export class SetupError extends Error {}

/**
 * Refuse to start against a database that is behind the code's migrations.
 * Otherwise the first click fails with "relation … does not exist", as it did
 * on 2026-10-01 when 0007's tables were added and the trial database was not
 * migrated. Tests migrate their own database; this guards the real one.
 */
async function requireMigrated(pool: { query: (sql: string) => Promise<{ rows: { n: string }[] }> }): Promise<void> {
  const journal = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')) as { entries: unknown[] };
  let applied = 0;
  try {
    const { rows } = await pool.query('SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations');
    applied = Number(rows[0]?.n ?? 0);
  } catch {
    applied = 0; // never migrated: the table does not exist yet
  }
  const missing = journal.entries.length - applied;
  if (missing > 0) {
    throw new SetupError(
      `Your database is missing ${missing} migration${missing === 1 ? '' : 's'}. Run \`npm run db:migrate\`, then try again.`,
    );
  }
}

export async function openSession(): Promise<Session> {
  const rawId = process.env['RETRACE_GITHUB_USER_ID'];
  const login = process.env['RETRACE_GITHUB_LOGIN'];
  const githubUserId = Number(rawId);
  if (!rawId || !Number.isSafeInteger(githubUserId) || !login) {
    throw new SetupError(
      'Set RETRACE_GITHUB_USER_ID and RETRACE_GITHUB_LOGIN in .env (see .env.example).\n' +
        'Your numeric id: https://api.github.com/users/<your-login> → "id".',
    );
  }
  if (!process.env['DATABASE_URL']) {
    throw new SetupError('Set DATABASE_URL in .env, then run `npm run db:migrate`.');
  }

  // Imported here, not at the top: client.ts connects on import.
  const { db, pool } = await import('./db/client.js');
  try {
    await requireMigrated(pool);
  } catch (error) {
    // Close the connection so the process exits at once with the message.
    await pool.end();
    throw error;
  }
  const userId = await ensureBuilder(db, { githubUserId, login });
  return { db, userId, end: () => pool.end() };
}
