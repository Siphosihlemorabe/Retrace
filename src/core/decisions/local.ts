/**
 * Local identity (0002): the one user, and the local clones they point at.
 *
 * The schema is GitHub-shaped. Rather than fake an installation, a local clone
 * is its own kind of repo (`source = 'local_clone'`), and the builder's user
 * row is seeded from their real GitHub identity — so when sign-in arrives it
 * finds this row instead of creating a second one.
 */
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';

import { sql } from 'drizzle-orm';

import { repos, users } from '../../db/schema.js';
import type { Executor } from '../../db/types.js';
import { currentBranch, firstParentRoot, type Repo } from '../git/index.js';

export interface BuilderIdentity {
  githubUserId: number;
  login: string;
}

/** The builder's `users` row, created on first use. Idempotent. */
export async function ensureBuilder(db: Executor, who: BuilderIdentity): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ githubUserId: who.githubUserId, login: who.login })
    // Logins can be renamed on GitHub; the numeric id cannot.
    .onConflictDoUpdate({ target: users.githubUserId, set: { login: who.login } })
    .returning({ id: users.id });
  if (row === undefined) throw new Error('could not create the builder user');
  return row.id;
}

export interface LocalClone {
  id: string;
  path: string;
  rootSha: string;
  name: string;
}

/**
 * A local clone as a `repos` row, keyed on canonical path + first-parent root.
 * Re-registering the same clone returns the same row.
 */
export async function registerLocalClone(db: Executor, repo: Repo): Promise<LocalClone> {
  // Canonical path, so `../x`, `./x/` and a differently-cased Windows path are
  // one repo, not three.
  const path = realpathSync.native(repo.path);
  const [rootSha, branch] = await Promise.all([firstParentRoot(repo), currentBranch(repo)]);
  const name = basename(path);

  const [row] = await db
    .insert(repos)
    .values({ source: 'local_clone', name, defaultBranch: branch, localPath: path, rootSha })
    .onConflictDoUpdate({
      target: [repos.localPath, repos.rootSha],
      targetWhere: sql`source = 'local_clone'`,
      set: { name, defaultBranch: branch },
    })
    .returning({ id: repos.id });
  if (row === undefined) throw new Error(`could not register ${path}`);

  return { id: row.id, path, rootSha, name };
}
