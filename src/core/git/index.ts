/**
 * Typed wrappers over git porcelain. Shells out rather than binding libgit2 —
 * everything the detector needs is `log`, `show`, and `grep`, and keeping it to
 * a subprocess means this module has no native build step.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** ASCII unit/record separators: safe inside commit messages, unlike newlines. */
const UNIT = '\x1f';
const RECORD = '\x1e';

export interface Repo {
  readonly path: string;
}

export interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: Date;
  subject: string;
}

export interface CommitStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  parentCount: number;
}

export interface RepoFacts {
  headSha: string;
  firstCommitAt: Date;
  commitCount: number;
}

export class GitError extends Error {}

async function git(repo: Repo, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', repo.path, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    throw new GitError(`git ${args[0]} failed: ${(error as Error).message}`);
  }
}

/** For commands whose "no results" is a non-zero exit rather than an error. */
async function gitAllowFail(repo: Repo, args: string[]): Promise<string> {
  try {
    return await git(repo, args);
  } catch {
    return '';
  }
}

export async function openRepo(path: string): Promise<Repo> {
  const repo: Repo = { path };
  try {
    await git(repo, ['rev-parse', '--git-dir']);
  } catch {
    throw new GitError(`not a git repository: ${path}`);
  }
  return repo;
}

/**
 * Every commit touching `filePath`, oldest first.
 *
 * Deliberately not using `--follow`: it interacts badly with `--reverse`, and a
 * renamed manifest is rare enough that silently-wrong history is the worse
 * trade. Monorepo support will pass an explicit path instead.
 */
export async function logForPath(repo: Repo, filePath: string): Promise<Commit[]> {
  const format = ['%H', '%an', '%ae', '%aI', '%s'].join(UNIT) + RECORD;
  const out = await git(repo, [
    'log',
    '--reverse',
    `--pretty=format:${format}`,
    '--',
    filePath,
  ]);

  const commits: Commit[] = [];
  for (const record of out.split(RECORD)) {
    const line = record.replace(/^\n/, '');
    if (line.trim() === '') continue;
    const [sha, authorName, authorEmail, authoredAt, subject] = line.split(UNIT);
    if (sha === undefined || authoredAt === undefined) continue;
    commits.push({
      sha,
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      authoredAt: new Date(authoredAt),
      subject: subject ?? '',
    });
  }
  return commits;
}

/** File contents at a revision, or null if the path did not exist there. */
export async function showFile(
  repo: Repo,
  sha: string,
  filePath: string,
): Promise<string | null> {
  try {
    return await git(repo, ['show', `${sha}:${filePath}`]);
  } catch {
    return null;
  }
}

export async function commitStats(repo: Repo, sha: string): Promise<CommitStats> {
  const out = await git(repo, [
    'show',
    '--numstat',
    `--format=%P${RECORD}`,
    sha,
  ]);

  const [parentsPart, statPart = ''] = out.split(RECORD);
  const parentCount = (parentsPart ?? '').trim().split(/\s+/).filter(Boolean).length;

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of statPart.split('\n')) {
    if (line.trim() === '') continue;
    const [ins, del] = line.split('\t');
    if (ins === undefined || del === undefined) continue;
    filesChanged += 1;
    // Binary files report '-'; count the file, not the lines.
    insertions += Number.parseInt(ins, 10) || 0;
    deletions += Number.parseInt(del, 10) || 0;
  }

  return { filesChanged, insertions, deletions, parentCount };
}

export async function repoFacts(repo: Repo): Promise<RepoFacts> {
  const headSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const commitCount = Number.parseInt(
    (await git(repo, ['rev-list', '--count', 'HEAD'])).trim(),
    10,
  );

  // Root commits: cheaper than walking the whole log to find the oldest.
  const roots = await git(repo, ['log', '--max-parents=0', '--format=%aI', 'HEAD']);
  const dates = roots
    .split('\n')
    .map((d) => d.trim())
    .filter((d) => d !== '')
    .map((d) => new Date(d).getTime());
  const firstCommitAt = new Date(dates.length > 0 ? Math.min(...dates) : Date.now());

  return { headSha, firstCommitAt, commitCount };
}

/** The set of root commit SHAs — used to spot scaffold commits. */
export async function rootShas(repo: Repo): Promise<Set<string>> {
  const out = await git(repo, ['log', '--max-parents=0', '--format=%H', 'HEAD']);
  return new Set(out.split('\n').map((s) => s.trim()).filter((s) => s !== ''));
}

const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'];

/**
 * How many source files import a package at HEAD. Proxy for load-bearing: a
 * dependency reached for in nine files shapes more than one used once.
 */
export async function countImportingFiles(
  repo: Repo,
  packageName: string,
): Promise<number> {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `(from|require\\()[[:space:]]*['"]${escaped}(/|['"])`;
  const out = await gitAllowFail(repo, [
    'grep',
    '-l',
    '-E',
    pattern,
    'HEAD',
    '--',
    ...SOURCE_GLOBS,
  ]);
  return out.split('\n').filter((l) => l.trim() !== '').length;
}
