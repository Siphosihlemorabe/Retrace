/**
 * Finding code that touches a project's goals (0007 §2–3).
 *
 * - **Backfill:** when a goal is set, every existing commit is sighted
 *   (`backfill`). That is the line between "before the goal" and "after".
 * - **Snapshot:** the code already present at that moment is scanned once, and
 *   each hit is attributed line by line with blame. Stored as `snapshot`.
 * - **Commits:** every commit sighted after that (`local_scan`) is scanned for
 *   the lines it added only. Stored as `commit`.
 *
 * Every result is a pointer (repo, SHA, path, lines), never code (G11).
 */
import { and, eq, inArray } from 'drizzle-orm';

import {
  commitSightings,
  learningGoals,
  lineLabels,
  outcomeSightings,
  skillOutcomes,
  skills,
} from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import { loadIdentitySet } from '../decisions/identity.js';
import {
  addedLines,
  commitMeta,
  commitPositions,
  filesAt,
  headSha,
  showFile,
  type Repo,
} from '../git/index.js';
import { BUILTIN_SKILLS, detectOutcomes, OUTCOMES_VERSION } from './catalog/index.js';
import {
  AUTHORSHIP_VERSION,
  blameAuthors,
  commitAuthors,
  CommitClassifier,
  dominantAuthorship,
  type LineLabel,
} from './line-authorship.js';
import { isCodeFile, isSqlFile } from './text.js';
import type { FileAtCommit, OutcomeDef } from './types.js';

/** Paths no outcome should ever be credited from. */
const IGNORED = /(^|\/)(node_modules|dist|build|\.next|coverage|vendor|\.git)\/|\.min\.[cm]?js$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const DOCKERISH = /(^|\/)(Dockerfile|Containerfile)([.\-][\w.-]+)?$|\.dockerfile$|(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$|(^|\/)\.dockerignore$/i;

/** Whether any built-in detector could match this path. A cheap filter before reading content. */
export const scannable = (path: string) =>
  !IGNORED.test(path) && (isSqlFile(path) || isCodeFile(path) || DOCKERISH.test(path));

export interface ScanScope {
  db: Db;
  userId: string;
  repo: Repo;
  repoId: string;
}

interface Target {
  defs: OutcomeDef[];
  idBySlug: Map<string, string>;
}

/** The built-in outcomes of every skill this project has a goal for. */
export async function goalOutcomes(db: Db, userId: string, repoId: string): Promise<Target> {
  const rows = await db
    .select({ id: skillOutcomes.id, slug: skillOutcomes.slug, skill: skills.slug })
    .from(learningGoals)
    .innerJoin(skills, eq(skills.id, learningGoals.skillId))
    .innerJoin(skillOutcomes, eq(skillOutcomes.skillId, skills.id))
    .where(
      and(
        eq(learningGoals.userId, userId),
        eq(learningGoals.repoId, repoId),
        eq(learningGoals.kind, 'intent'),
        eq(skillOutcomes.source, 'builtin'),
      ),
    );
  const slugs = new Set(rows.map((r) => r.slug));
  const defs = BUILTIN_SKILLS.flatMap((s) => s.outcomes).filter((o) => slugs.has(o.slug));
  return { defs, idBySlug: new Map(rows.map((r) => [r.slug, r.id])) };
}

export async function labelsFor(db: Db, repoId: string): Promise<LineLabel[]> {
  const rows = await db
    .select()
    .from(lineLabels)
    .where(eq(lineLabels.repoId, repoId))
    .orderBy(lineLabels.createdAt);
  return rows.map((r) => ({
    sha: r.sha,
    path: r.path,
    lineStart: r.lineStart,
    lineEnd: r.lineEnd,
    label: r.label as 'agent' | 'me',
  }));
}

/** Sight every commit not yet sighted, as `backfill`. Returns how many were new. */
export async function backfillSightings(db: Db, repo: Repo, repoId: string): Promise<number> {
  const { indexOf } = await commitPositions(repo);
  const shas = [...indexOf.keys()];
  let added = 0;
  for (let i = 0; i < shas.length; i += 500) {
    const rows = await db
      .insert(commitSightings)
      .values(shas.slice(i, i + 500).map((sha) => ({ repoId, sha, source: 'backfill' })))
      .onConflictDoNothing()
      .returning({ id: commitSightings.id });
    added += rows.length;
  }
  return added;
}

/**
 * Scan the code as it is at HEAD for the given outcomes, attributing each hit
 * by blame. Used when a goal is set, so outcomes already in the project show as
 * touched *before the goal*.
 */
export async function snapshotScan(scope: ScanScope, target: Target): Promise<number> {
  const { db, repo, repoId } = scope;
  if (target.defs.length === 0) return 0;
  const sha = await headSha(repo);
  const classifier = new CommitClassifier(repo, await loadIdentitySet(db, scope.userId));
  const labels = await labelsFor(db, repoId);

  let found = 0;
  for (const path of (await filesAt(repo, sha)).filter(scannable)) {
    const content = await showFile(repo, sha, path);
    if (content === null) continue;
    const file: FileAtCommit = { path, lines: content.split('\n'), added: new Set() };
    for (const hit of detectOutcomes(file, target.defs)) {
      const authors = await blameAuthors(repo, classifier, sha, path, hit.start, hit.end, labels);
      found += await recordSighting(db, {
        repoId,
        outcomeId: target.idBySlug.get(hit.outcome),
        sha,
        path,
        hit,
        scanKind: 'snapshot',
        authorship: dominantAuthorship(authors),
      });
    }
  }
  return found;
}

/**
 * Sight and scan every commit not yet seen, oldest first, crediting only the
 * lines each commit added. This is what runs whenever the app is opened.
 */
export async function scanNewCommits(scope: ScanScope): Promise<{ commits: number; sightings: number }> {
  const { db, repo, repoId } = scope;
  const target = await goalOutcomes(db, scope.userId, repoId);
  if (target.defs.length === 0) return { commits: 0, sightings: 0 };

  const { indexOf } = await commitPositions(repo);
  const seen = new Set(
    (await db.select({ sha: commitSightings.sha }).from(commitSightings).where(eq(commitSightings.repoId, repoId))).map(
      (r) => r.sha,
    ),
  );
  const fresh = [...indexOf.keys()].filter((sha) => !seen.has(sha));
  if (fresh.length === 0) return { commits: 0, sightings: 0 };

  const classifier = new CommitClassifier(repo, await loadIdentitySet(db, scope.userId));
  const labels = await labelsFor(db, repoId);
  let sightings = 0;

  for (const sha of fresh) {
    // Sight first: the moment this tool first saw the commit is the record.
    await db.insert(commitSightings).values({ repoId, sha, source: 'local_scan' }).onConflictDoNothing();
    const meta = await commitMeta(repo, sha);
    const changed = await addedLines(repo, sha, meta.parentCount);
    for (const [path, added] of changed) {
      if (!scannable(path)) continue;
      const content = await showFile(repo, sha, path);
      if (content === null) continue;
      const file: FileAtCommit = { path, lines: content.split('\n'), added };
      for (const hit of detectOutcomes(file, target.defs)) {
        const authors = await commitAuthors(classifier, sha, path, hit.start, hit.end, labels);
        sightings += await recordSighting(db, {
          repoId,
          outcomeId: target.idBySlug.get(hit.outcome),
          sha,
          path,
          hit,
          scanKind: 'commit',
          authorship: dominantAuthorship(authors),
        });
      }
    }
  }
  return { commits: fresh.length, sightings };
}

async function recordSighting(
  db: Db,
  s: {
    repoId: string;
    outcomeId: string | undefined;
    sha: string;
    path: string;
    hit: { start: number; end: number; via: string };
    scanKind: 'commit' | 'snapshot';
    authorship: string;
  },
): Promise<number> {
  if (s.outcomeId === undefined) return 0;
  const rows = await db
    .insert(outcomeSightings)
    .values({
      repoId: s.repoId,
      outcomeId: s.outcomeId,
      sha: s.sha,
      path: s.path,
      lineStart: s.hit.start,
      lineEnd: s.hit.end,
      via: s.hit.via,
      foundBy: 'rule',
      scanKind: s.scanKind,
      authorship: s.authorship,
      authorshipVersion: AUTHORSHIP_VERSION,
      detectorVersion: OUTCOMES_VERSION,
    })
    .onConflictDoNothing()
    .returning({ id: outcomeSightings.id });
  return rows.length;
}

/**
 * The builder relabels lines ("an AI wrote this"). Stored, then every
 * sighting it overlaps at that commit is re-attributed, so coverage changes at
 * once rather than at the next scan.
 */
export async function relabelLines(
  scope: ScanScope,
  label: { sha: string; path: string; lineStart: number; lineEnd: number; label: 'agent' | 'me' },
): Promise<number> {
  const { db, repo, repoId } = scope;
  await db.insert(lineLabels).values({ userId: scope.userId, repoId, ...label });

  const affected = (
    await db
      .select()
      .from(outcomeSightings)
      .where(and(eq(outcomeSightings.repoId, repoId), eq(outcomeSightings.sha, label.sha), eq(outcomeSightings.path, label.path)))
  ).filter((s) => s.lineStart <= label.lineEnd && s.lineEnd >= label.lineStart);
  if (affected.length === 0) return 0;

  const classifier = new CommitClassifier(repo, await loadIdentitySet(db, scope.userId));
  const labels = await labelsFor(db, repoId);
  for (const s of affected) {
    const authors =
      s.scanKind === 'commit'
        ? await commitAuthors(classifier, s.sha, s.path, s.lineStart, s.lineEnd, labels)
        : await blameAuthors(repo, classifier, s.sha, s.path, s.lineStart, s.lineEnd, labels);
    await db
      .update(outcomeSightings)
      .set({ authorship: dominantAuthorship(authors) })
      .where(inArray(outcomeSightings.id, [s.id]));
  }
  return affected.length;
}
