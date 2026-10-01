/**
 * Coverage for a skill whose list the builder reviewed (0009 §3): a model
 * reads the code and says which lines touch which outcome. Shown as "found by
 * the model", with links to the lines.
 *
 * Cost scales with likely matches, not with repo size:
 * - a cheap filter first: only files with a line containing one of the
 *   outcomes' `lookFor` cues are read by the model, and only around those lines
 * - cached by git blob, so a file that hasn't changed is never read twice, in
 *   any commit
 * - a per-run limit on model calls, under the daily cap. A run that stops early
 *   picks up where it left off next time, because finished files are cached
 *
 * It reads the code at HEAD, not commit by commit: one read per changed file,
 * however many commits touched it. Whether lines were written after the goal
 * comes from blame and from when this tool first saw each commit (server
 * time, not git dates).
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';

import { commitSightings, learningGoals, outcomeSightings, skillOutcomes } from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import { loadIdentitySet } from '../decisions/identity.js';
import { blobSha, filesAt, headSha, showFile, type Repo } from '../git/index.js';
import { completeJson, providerFromEnv, type Provider } from '../llm/index.js';
import { AUTHORSHIP_VERSION, blameAuthors, CommitClassifier, dominantAuthorship } from './line-authorship.js';
import { IGNORED, labelsFor } from './scan.js';

export const MODEL_SCAN_VERSION = 1;

/** Lines either side of a cue the model is shown. */
const AROUND = 6;
/** Per file. Beyond this, the file's later cues wait for a smaller file or a later list. */
const MAX_SHOWN_LINES = 160;
const MAX_FILE_BYTES = 200_000;
/** Text files worth reading; config counts, because much of a skill like Redis lives in it. */
const TEXTISH = /\.([cm]?[jt]sx?|py|rb|go|rs|java|kt|cs|php|sql|ya?ml|json|toml|ini|conf|cfg|env\.example|sh|lua|tf)$|(^|\/)(Dockerfile|Makefile|Procfile)$/i;

export const MODEL_SCAN_SYSTEM = `You find where code in a developer's project touches learning outcomes.

You are given a list of outcomes (id, name, description) and numbered excerpts from one file. Report each place where the code actually does one of the outcomes. A mention in a comment, a string, a log message, or a variable name alone does not count. Report the smallest line range that shows it. Report nothing you are unsure about.

Only use line numbers that appear in the excerpts, and only outcome ids from the list.

Reply with JSON only, in exactly this shape (an empty list is a fine answer):
{"hits":[{"outcome":"<id>","lines":[from,to]}]}`;

const ScanOutput = z.object({
  hits: z
    .array(z.object({ outcome: z.string(), lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]) }))
    .max(30),
});

export interface ModelScanScope {
  db: Db;
  userId: string;
  repo: Repo;
  repoId: string;
  /** Whether the builder agreed this repo's code may go to an off-machine model. */
  llmAllowed: boolean;
}

export type ModelScanResult =
  | {
      ok: true;
      /** Files whose cues matched. */
      candidates: number;
      /** Files the model read this run (not counting cached ones). */
      read: number;
      cached: number;
      sightings: number;
      failed: number;
      /** Set when the run stopped before every candidate file: more next time. */
      stopped: 'run_limit' | 'capped' | null;
    }
  | { ok: false; reason: 'off' | 'no_consent' | 'no_list' | 'no_goal'; message: string };

interface Cued {
  slug: string;
  id: string;
  name: string;
  description: string;
  cues: string[];
}

/** Ranges of matched lines, widened and merged, within a budget of lines. */
function windows(matched: readonly number[], total: number): [number, number][] {
  const out: [number, number][] = [];
  let shown = 0;
  for (const n of matched) {
    const from = Math.max(1, n - AROUND);
    const to = Math.min(total, n + AROUND);
    const last = out.at(-1);
    if (last !== undefined && from <= last[1] + 1) {
      shown += Math.max(0, to - last[1]);
      last[1] = Math.max(last[1], to);
    } else {
      out.push([from, to]);
      shown += to - from + 1;
    }
    if (shown >= MAX_SHOWN_LINES) break;
  }
  return out;
}

export async function modelScan(
  scope: ModelScanScope,
  skillId: string,
  provider: Provider | null = providerFromEnv(),
  opts: { maxCalls?: number } = {},
): Promise<ModelScanResult> {
  const { db, userId, repo, repoId } = scope;
  const maxCalls = opts.maxCalls ?? 10;
  if (provider === null) return { ok: false, reason: 'off', message: 'No model is connected.' };
  if (provider.sendsCodeOffMachine && !scope.llmAllowed) {
    return { ok: false, reason: 'no_consent', message: `This project's code has not been allowed to go to ${provider.name}.` };
  }

  const [goal] = await db
    .select({ openedAt: learningGoals.openedAt })
    .from(learningGoals)
    .where(and(eq(learningGoals.userId, userId), eq(learningGoals.repoId, repoId), eq(learningGoals.skillId, skillId), eq(learningGoals.kind, 'intent')));
  if (goal === undefined) return { ok: false, reason: 'no_goal', message: 'This project has no goal for that skill.' };

  const rows = await db
    .select()
    .from(skillOutcomes)
    .where(and(eq(skillOutcomes.skillId, skillId), ne(skillOutcomes.source, 'builtin'), isNull(skillOutcomes.retiredAt)))
    .orderBy(skillOutcomes.ordinal);
  const outcomes: Cued[] = rows.flatMap((r) => {
    const cues = z.array(z.string()).safeParse(r.lookFor);
    return cues.success && cues.data.length > 0
      ? [{ slug: r.slug, id: r.id, name: r.name, description: r.description, cues: cues.data.map((c) => c.toLowerCase()) }]
      : [];
  });
  if (outcomes.length === 0) return { ok: false, reason: 'no_list', message: 'That skill has no reviewed outcome list yet.' };
  const bySlug = new Map(outcomes.map((o) => [o.slug, o]));
  // Part of the cache key: editing the list means reading again.
  const listKey = JSON.stringify(outcomes.map((o) => [o.slug, o.name, o.description, o.cues]));
  const outcomeList = outcomes.map((o) => `${o.slug}: ${o.name} — ${o.description}`).join('\n');

  const head = await headSha(repo);
  const classifier = new CommitClassifier(repo, await loadIdentitySet(db, userId));
  const labels = await labelsFor(db, repoId);
  const firstSeen = new Map(
    (await db.select().from(commitSightings).where(eq(commitSightings.repoId, repoId))).map((s) => [s.sha, s]),
  );
  const afterGoal = (sha: string) => {
    const s = firstSeen.get(sha);
    // Not seen yet means it arrived after every goal was set: backfill sights all history then.
    return s === undefined || (s.source !== 'backfill' && s.firstSeenAt >= goal.openedAt);
  };

  const result = { ok: true as const, candidates: 0, read: 0, cached: 0, sightings: 0, failed: 0, stopped: null as 'run_limit' | 'capped' | null };

  for (const path of (await filesAt(repo, head)).filter((p) => !IGNORED.test(p) && TEXTISH.test(p))) {
    const content = await showFile(repo, head, path);
    if (content === null || content.length > MAX_FILE_BYTES || content.includes('\0')) continue;
    const lines = content.replace(/\n$/, '').split('\n');
    const matched = lines.flatMap((text, i) => {
      const lower = text.toLowerCase();
      return outcomes.some((o) => o.cues.some((c) => lower.includes(c))) ? [i + 1] : [];
    });
    if (matched.length === 0) continue;
    result.candidates += 1;
    if (result.stopped !== null) continue;

    const blob = await blobSha(repo, head, path);
    if (blob === null) continue;
    const shown = windows(matched, lines.length);
    const excerpt = shown
      .map(([from, to]) => lines.slice(from - 1, to).map((t, i) => `${from + i}  ${t}`).join('\n'))
      .join('\n…\n');

    if (result.read >= maxCalls) {
      result.stopped = 'run_limit';
      continue;
    }
    const reply = await completeJson(
      db,
      userId,
      {
        purpose: 'outcomes:scan',
        promptVersion: MODEL_SCAN_VERSION,
        system: MODEL_SCAN_SYSTEM,
        input: `Outcomes:\n${outcomeList}\n\nFile: ${path}\n\n${excerpt}`,
        schema: ScanOutput,
        cacheParts: [blob, listKey],
        repoId,
        sha: head,
      },
      provider,
    );
    if (!reply.ok) {
      if (reply.reason === 'capped') result.stopped = 'capped';
      else result.failed += 1;
      continue;
    }
    if (reply.cached) result.cached += 1;
    else result.read += 1;

    // Already recorded from this exact content at an earlier HEAD: the hits are the same lines.
    const earlier = await db
      .selectDistinct({ sha: outcomeSightings.sha })
      .from(outcomeSightings)
      .where(and(eq(outcomeSightings.repoId, repoId), eq(outcomeSightings.path, path), eq(outcomeSightings.foundBy, 'model'), inArray(outcomeSightings.outcomeId, outcomes.map((o) => o.id))));
    let unchanged = false;
    for (const e of earlier) if (e.sha !== head && (await blobSha(repo, e.sha, path)) === blob) unchanged = true;
    if (unchanged) continue;

    const inShown = ([a, b]: [number, number]) => a <= b && shown.some(([from, to]) => a >= from && b <= to);
    for (const hit of reply.value.hits) {
      const outcome = bySlug.get(hit.outcome);
      // An outcome not on the list, or lines the model never saw: dropped, not trusted.
      if (outcome === undefined || !inShown(hit.lines)) continue;
      const [start, end] = hit.lines;
      const authors = await blameAuthors(repo, classifier, head, path, start, end, labels);
      const rowsIn = await db
        .insert(outcomeSightings)
        .values({
          repoId,
          outcomeId: outcome.id,
          sha: head,
          path,
          lineStart: start,
          lineEnd: end,
          via: 'code',
          foundBy: 'model',
          scanKind: 'snapshot',
          authorship: dominantAuthorship(authors),
          authorshipVersion: AUTHORSHIP_VERSION,
          detectorVersion: MODEL_SCAN_VERSION,
          // After the goal only if every line was: never claim progress that predates it.
          writtenAfterGoal: authors.length > 0 && authors.every((a) => afterGoal(a.sha)),
        })
        .onConflictDoNothing()
        .returning({ id: outcomeSightings.id });
      result.sightings += rowsIn.length;
    }
  }
  return result;
}

