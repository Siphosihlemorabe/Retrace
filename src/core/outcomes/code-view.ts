/**
 * The code view (0007): a file at one commit, every line labelled with who
 * wrote it (blame + 0003, with the builder's relabels), and the ranges that
 * touch the project's goals highlighted.
 *
 * Code is read from the local clone and returned to the builder's own browser.
 * Nothing here is stored (G11).
 */
import { and, eq } from 'drizzle-orm';

import { outcomeSightings, skillOutcomes } from '../../db/schema.js';
import { loadIdentitySet } from '../decisions/identity.js';
import { showFile } from '../git/index.js';
import { blameAuthors, CommitClassifier } from './line-authorship.js';
import { labelsFor, type ScanScope } from './scan.js';

/** Files longer than this are not blamed in full; the view says so. */
export const MAX_VIEW_LINES = 3000;

export interface CodeView {
  lines: { n: number; text: string; authorship: string; actor: string | null; relabelled: boolean }[];
  highlights: { start: number; end: number; outcome: string; name: string }[];
}

export async function codeView(scope: ScanScope, sha: string, path: string): Promise<CodeView | null> {
  const { db, repo, repoId } = scope;
  const content = await showFile(repo, sha, path);
  if (content === null) return null;

  const text = content.endsWith('\n') ? content.slice(0, -1) : content;
  const raw = text.split('\n');
  if (raw.length > MAX_VIEW_LINES) throw new Error(`${path} has ${raw.length} lines; the code view stops at ${MAX_VIEW_LINES}.`);

  const classifier = new CommitClassifier(repo, await loadIdentitySet(db, scope.userId));
  const authors = raw.length === 0 ? [] : await blameAuthors(repo, classifier, sha, path, 1, raw.length, await labelsFor(db, repoId));
  const byLine = new Map(authors.map((a) => [a.line, a]));

  const highlights = await db
    .select({
      start: outcomeSightings.lineStart,
      end: outcomeSightings.lineEnd,
      outcome: skillOutcomes.slug,
      name: skillOutcomes.name,
    })
    .from(outcomeSightings)
    .innerJoin(skillOutcomes, eq(skillOutcomes.id, outcomeSightings.outcomeId))
    .where(and(eq(outcomeSightings.repoId, repoId), eq(outcomeSightings.sha, sha), eq(outcomeSightings.path, path)));

  return {
    lines: raw.map((line, i) => {
      const a = byLine.get(i + 1);
      return {
        n: i + 1,
        text: line,
        authorship: a?.authorship ?? 'unknown',
        actor: a?.actor ?? null,
        relabelled: a?.relabelled ?? false,
      };
    }),
    highlights,
  };
}
