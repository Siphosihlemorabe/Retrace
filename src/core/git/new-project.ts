/**
 * "New project" (0007, decided by the builder): a local folder with git set up
 * and an empty first commit, so goals can be set before any code exists —
 * the strongest "I planned to learn this" record there is. Creating the repo
 * on GitHub as well is a separate, optional step.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

import { GitError, openRepo, type Repo } from './index.js';

const exec = promisify(execFile);

async function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, { cwd, windowsHide: true });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new GitError(`${cmd} ${args[0]} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

/**
 * Create `path` as a new git repo with one empty commit. Refuses a folder that
 * already has files in it: that is an existing project, and "set goals on an
 * existing project" is the path for it.
 */
export async function createProjectFolder(path: string): Promise<Repo> {
  const full = resolve(path);
  const existing = await readdir(full).catch(() => null);
  if (existing !== null && existing.length > 0) {
    throw new GitError(`${full} already has files in it. To set goals on an existing project, add it as a repo instead.`);
  }
  await mkdir(full, { recursive: true });
  await run('git', ['init', '-b', 'main'], full);
  // Uses the builder's own git identity; git explains clearly if none is set.
  await run('git', ['commit', '--allow-empty', '-m', 'Start project'], full);
  return openRepo(full);
}

/** Whether GitHub's `gh` tool is installed and logged in. */
export async function githubCliReady(): Promise<boolean> {
  try {
    await exec('gh', ['auth', 'status'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the repo on GitHub and push the first commit. Outward-facing — it
 * changes the builder's GitHub account — so callers must have the builder's
 * explicit confirmation, every time, before calling this.
 */
export async function createGithubRepo(
  repo: Repo,
  visibility: 'private' | 'public',
): Promise<string> {
  const name = basename(resolve(repo.path));
  const out = await run(
    'gh',
    ['repo', 'create', name, `--${visibility}`, '--source', repo.path, '--remote', 'origin', '--push'],
    repo.path,
  );
  const url = /https:\/\/github\.com\/\S+/.exec(out)?.[0];
  return url ?? name;
}
