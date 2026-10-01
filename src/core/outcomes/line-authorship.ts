/**
 * Who wrote each line (0007 §4): git blame gives the commit behind a line, and
 * 0003's classifier says who made that commit. The builder's own relabels
 * ("an AI wrote this, though I committed it") override that for exactly the
 * lines they cover. Nothing is guessed from how code looks.
 */
import {
  AUTHORSHIP_VERSION,
  classifyCommit,
  type Authorship,
  type CommitAuthorship,
  type IdentitySet,
} from '../detect/authorship.js';
import { blameLines, commitMeta, rootShas, type Repo } from '../git/index.js';

export { AUTHORSHIP_VERSION };

export interface LineAuthor {
  line: number;
  sha: string;
  authorship: Authorship;
  actor: string | null;
  /** True when the builder's relabel decided this line, not commit history. */
  relabelled: boolean;
}

export interface LineLabel {
  sha: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  label: 'agent' | 'me';
}

/** Classifies commits once each; a repo scan touches the same commits many times. */
export class CommitClassifier {
  private readonly cache = new Map<string, Promise<CommitAuthorship>>();
  private roots: Promise<Set<string>> | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly identities: IdentitySet,
  ) {}

  classify(sha: string): Promise<CommitAuthorship> {
    let hit = this.cache.get(sha);
    if (hit === undefined) {
      this.roots ??= rootShas(this.repo);
      const roots = this.roots;
      hit = (async () => classifyCommit(await commitMeta(this.repo, sha), (await roots).has(sha), this.identities))();
      this.cache.set(sha, hit);
    }
    return hit;
  }
}

function applyLabels(lines: LineAuthor[], labels: readonly LineLabel[], sha: string, path: string): LineAuthor[] {
  const mine = labels.filter((l) => l.sha === sha && l.path === path);
  if (mine.length === 0) return lines;
  return lines.map((l) => {
    // The most recent relabel covering the line wins: labels arrive oldest first.
    const label = [...mine].reverse().find((x) => l.line >= x.lineStart && l.line <= x.lineEnd);
    if (label === undefined) return l;
    return {
      ...l,
      authorship: label.label === 'me' ? 'builder' : 'agent',
      actor: 'you said',
      relabelled: true,
    };
  });
}

/** Per-line authors for a range at `sha`, from blame, with relabels applied. */
export async function blameAuthors(
  repo: Repo,
  classifier: CommitClassifier,
  sha: string,
  path: string,
  start: number,
  end: number,
  labels: readonly LineLabel[] = [],
): Promise<LineAuthor[]> {
  const blamed = await blameLines(repo, sha, path, start, end);
  const lines: LineAuthor[] = [];
  for (let n = start; n <= end; n += 1) {
    const lineSha = blamed.get(n);
    if (lineSha === undefined) continue;
    const by = await classifier.classify(lineSha);
    lines.push({ line: n, sha: lineSha, authorship: by.authorship, actor: by.actor, relabelled: false });
  }
  return applyLabels(lines, labels, sha, path);
}

/**
 * Per-line authors for lines a commit just added: all that commit's, so no
 * blame is needed. Relabels still apply.
 */
export async function commitAuthors(
  classifier: CommitClassifier,
  sha: string,
  path: string,
  start: number,
  end: number,
  labels: readonly LineLabel[] = [],
): Promise<LineAuthor[]> {
  const by = await classifier.classify(sha);
  const lines: LineAuthor[] = [];
  for (let n = start; n <= end; n += 1) {
    lines.push({ line: n, sha, authorship: by.authorship, actor: by.actor, relabelled: false });
  }
  return applyLabels(lines, labels, sha, path);
}

/** When a range mixes authors, ties go away from the builder: never overstate them. */
const TIE_ORDER: readonly Authorship[] = [
  'agent',
  'other_human',
  'automation',
  'template',
  'unknown',
  'builder_with_agent',
  'builder',
];

/** One label for a range: whoever wrote most of its lines. */
export function dominantAuthorship(lines: readonly LineAuthor[]): Authorship {
  if (lines.length === 0) return 'unknown';
  const counts = new Map<Authorship, number>();
  for (const l of lines) counts.set(l.authorship, (counts.get(l.authorship) ?? 0) + 1);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || TIE_ORDER.indexOf(a[0]) - TIE_ORDER.indexOf(b[0]),
  )[0]![0];
}
