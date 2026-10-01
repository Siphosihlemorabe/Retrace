/**
 * Throwaway git repos with history that is known in advance, so detector and
 * authorship changes are measured rather than judged on vibes.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Author {
  name: string;
  email: string;
}

export interface CommitOptions {
  /** Days after 2025-01-01. Dates are fiction in real repos too. */
  day?: number;
  author?: Author;
  /** Message body, e.g. trailers. */
  body?: string;
}

export interface FixtureRepo {
  dir: string;
  write(path: string, contents: string): Promise<void>;
  commit(subject: string, options?: CommitOptions): Promise<string>;
  git(args: string[]): Promise<string>;
  remove(): Promise<void>;
}

export const FIXTURE_AUTHOR: Author = { name: 'Fixture', email: 'fixture@example.com' };

export async function createFixtureRepo(): Promise<FixtureRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'retrace-fixture-'));

  const run = async (args: string[], env: NodeJS.ProcessEnv = process.env) =>
    (await exec('git', ['-C', dir, ...args], { env, windowsHide: true })).stdout;

  await run(['init', '-b', 'main']);
  await run(['config', 'user.email', FIXTURE_AUTHOR.email]);
  await run(['config', 'user.name', FIXTURE_AUTHOR.name]);
  await run(['config', 'commit.gpgsign', 'false']);

  return {
    dir,
    git: (args) => run(args),
    async write(path, contents) {
      const full = join(dir, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, contents, 'utf8');
    },
    async commit(subject, options = {}) {
      const author = options.author ?? FIXTURE_AUTHOR;
      const date = new Date(Date.UTC(2025, 0, 1 + (options.day ?? 0), 12)).toISOString();
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      };
      await run(['add', '-A'], env);
      const message = options.body === undefined ? subject : `${subject}\n\n${options.body}`;
      await run(['commit', '--allow-empty', '-m', message], env);
      return (await run(['rev-parse', 'HEAD'])).trim();
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}
