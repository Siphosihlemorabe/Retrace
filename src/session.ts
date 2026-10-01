/**
 * What every database-backed entry point (CLI, local server) needs: a connection, and the builder.
 *
 * The builder is seeded from their real GitHub identity in .env
 * (RETRACE_GITHUB_USER_ID, RETRACE_GITHUB_LOGIN), so sign-in later finds this
 * row rather than creating a second one (0002).
 */
import { ensureBuilder } from './core/decisions/local.js';
import type { Db } from './db/types.js';

export interface Session {
  db: Db;
  userId: string;
  end(): Promise<void>;
}

export class SetupError extends Error {}

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
  const userId = await ensureBuilder(db, { githubUserId, login });
  return { db, userId, end: () => pool.end() };
}
