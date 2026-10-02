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

export interface CommitMeta {
  sha: string;
  authorName: string;
  authorEmail: string;
  subject: string;
  /** Full message body — trailers such as `Co-Authored-By` live here. */
  body: string;
  parentCount: number;
}

/** Author, message and parents of one commit: what authorship is judged from. */
export async function commitMeta(repo: Repo, sha: string): Promise<CommitMeta> {
  const format = ['%H', '%an', '%ae', '%s', '%P', '%b'].join(UNIT);
  const out = await git(repo, ['show', '-s', `--format=${format}`, sha]);
  const [fullSha = sha, authorName = '', authorEmail = '', subject = '', parents = '', body = ''] =
    out.split(UNIT);
  return {
    sha: fullSha.trim(),
    authorName,
    authorEmail,
    subject,
    body: body.trimEnd(),
    parentCount: parents.trim().split(/\s+/).filter(Boolean).length,
  };
}

export interface CommitPositions {
  /** 1-based position in topological order, oldest first. */
  indexOf: ReadonlyMap<string, number>;
  total: number;
}

/**
 * Where each commit sits in the project's history: "commit 5 of 482".
 *
 * Position, not date, because git dates are set by whoever made the commit —
 * every Lovable root commit says 2025-01-01. Topological rather than
 * first-parent: on a repo with merged branches a first-parent walk never sees
 * commits made on a branch (frontend-fixer's e322be8 is one of them).
 */
export async function commitPositions(repo: Repo): Promise<CommitPositions> {
  const out = await git(repo, ['rev-list', '--reverse', '--topo-order', 'HEAD']);
  const shas = out.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  return {
    indexOf: new Map(shas.map((sha, i) => [sha, i + 1])),
    total: shas.length,
  };
}

export interface AuthorIdentity {
  /** Lower-cased: emails are matched case-insensitively everywhere (citext). */
  email: string;
  /** The name most often used with this email. */
  name: string;
  commits: number;
}

/**
 * Distinct author emails in a repo, most commits first. Raw `%an`/`%ae`, not
 * `.mailmap`-resolved: authorship is judged from what the commit itself says.
 */
export async function authorIdentities(repo: Repo): Promise<AuthorIdentity[]> {
  const out = await git(repo, ['log', `--format=%an${UNIT}%ae`, 'HEAD']);
  const byEmail = new Map<string, { names: Map<string, number>; commits: number }>();

  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const [name = '', rawEmail = ''] = line.split(UNIT);
    const email = rawEmail.trim().toLowerCase();
    const entry = byEmail.get(email) ?? { names: new Map(), commits: 0 };
    entry.commits += 1;
    entry.names.set(name, (entry.names.get(name) ?? 0) + 1);
    byEmail.set(email, entry);
  }

  return [...byEmail.entries()]
    .map(([email, { names, commits }]) => ({
      email,
      name: [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
      commits,
    }))
    .sort((a, b) => b.commits - a.commits || a.email.localeCompare(b.email));
}

/**
 * The root reached by following first parents from HEAD. Part of a local
 * clone's identity: unlike "any root", it stays the same as history grows,
 * and a repo that merged in unrelated history still has exactly one.
 */
export async function firstParentRoot(repo: Repo): Promise<string> {
  const out = await git(repo, ['rev-list', '--first-parent', '--max-parents=0', 'HEAD']);
  const root = out.split('\n').map((s) => s.trim()).find((s) => s !== '');
  if (root === undefined) throw new GitError(`no root commit found in ${repo.path}`);
  return root;
}

/** The checked-out branch, or `HEAD` when detached. */
export async function currentBranch(repo: Repo): Promise<string> {
  const out = await gitAllowFail(repo, ['symbolic-ref', '--short', 'HEAD']);
  return out.trim() === '' ? 'HEAD' : out.trim();
}

/** Tracked paths at HEAD — what the cost check can recognise as "this repo". */
export async function trackedFiles(repo: Repo): Promise<string[]> {
  const out = await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']);
  return out.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * The line numbers (in the new file) each file gained in a commit, against its
 * first parent. A root commit added every line it contains. Deleted files and
 * binary files have none.
 */
export async function addedLines(
  repo: Repo,
  sha: string,
  parentCount: number,
): Promise<Map<string, Set<number>>> {
  const args =
    parentCount === 0
      ? ['show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', sha]
      : ['diff', '--unified=0', '--no-color', '--no-ext-diff', `${sha}^1`, sha];
  const out = await git(repo, args);

  const result = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim().replace(/^"(.*)"$/, '$1');
      if (target === '/dev/null') {
        current = null;
        continue;
      }
      const path = target.replace(/^b\//, '');
      current = result.get(path) ?? new Set();
      result.set(path, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk !== null && current !== null) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n += 1) current.add(n);
    }
  }
  for (const [path, lines] of result) if (lines.size === 0) result.delete(path);
  return result;
}

/** Which commit last changed each line in a range, at `sha`. */
export async function blameLines(
  repo: Repo,
  sha: string,
  path: string,
  start: number,
  end: number,
): Promise<Map<number, string>> {
  const out = await git(repo, ['blame', '--porcelain', '-L', `${start},${end}`, sha, '--', path]);
  const result = new Map<number, string>();
  for (const line of out.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (header !== null) result.set(Number(header[2]), header[1] as string);
  }
  return result;
}

/** Every tracked path at a commit. */
export async function filesAt(repo: Repo, sha: string): Promise<string[]> {
  const out = await git(repo, ['ls-tree', '-r', '--name-only', sha]);
  return out.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

/** HEAD's full SHA. */
export async function headSha(repo: Repo): Promise<string> {
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

/** Up to `limit` (path, line) places at HEAD whose line matches an extended regex. */
export async function grepLines(repo: Repo, pattern: string, limit: number): Promise<{ path: string; line: number }[]> {
  const out = await gitAllowFail(repo, ['grep', '-n', '-E', pattern, 'HEAD', '--', ...SOURCE_GLOBS]);
  const places: { path: string; line: number }[] = [];
  for (const row of out.split('\n')) {
    // "HEAD:src/a.ts:12:import x from 'y'"
    const m = /^HEAD:(.+?):(\d+):/.exec(row);
    if (m !== null) places.push({ path: m[1] as string, line: Number(m[2]) });
    if (places.length >= limit) break;
  }
  return places;
}

/** The blob a path points at in a commit: the same content has the same id in every commit. */
export async function blobSha(repo: Repo, sha: string, path: string): Promise<string | null> {
  const out = (await gitAllowFail(repo, ['rev-parse', `${sha}:${path}`])).trim();
  return /^[0-9a-f]{40}$/.test(out) ? out : null;
}

export interface LineOrigin {
  /** The commit that last changed the line. */
  sha: string;
  /** The line's number and path in that commit: stable across later commits that leave it alone. */
  line: number;
  path: string;
}

/** Blame with each line's origin: commit, line number and path there. */
export async function blameOrigins(repo: Repo, sha: string, path: string, start: number, end: number): Promise<Map<number, LineOrigin>> {
  const out = await git(repo, ['blame', '--line-porcelain', '-L', `${start},${end}`, sha, '--', path]);
  const result = new Map<number, LineOrigin>();
  let current: { sha: string; line: number; final: number } | null = null;
  for (const row of out.split('\n')) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(row);
    if (header !== null) {
      current = { sha: header[1] as string, line: Number(header[2]), final: Number(header[3]) };
      continue;
    }
    if (current !== null && row.startsWith('filename ')) {
      result.set(current.final, { sha: current.sha, line: current.line, path: row.slice('filename '.length) });
      current = null;
    }
  }
  return result;
}
