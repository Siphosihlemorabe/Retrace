/**
 * Who wrote each line (0007 §4): git blame gives the commit behind a line, and
 * 0003's classifier says who made that commit. The builder's own relabels
 * ("an AI wrote this, though I committed it") override that for exactly the
 * lines they cover. Nothing is guessed from how code looks.
 */
import {
  classifyCommit,
  type Authorship,
  type CommitAuthorship,
  type IdentitySet,
} from '../detect/authorship.js';
import { blameOrigins, commitMeta, rootShas, type Repo } from '../git/index.js';

/**
 * Line authorship's own version, stored on every sighting. 0003's commit
 * classifier underneath stays v1 for dependency questions.
 *
 * v2: a root commit by an identity you said is yours reads "not confirmed"
 * rather than "template" (an imported project's first commit is often your own
 * code), and relabels follow the lines to later commits.
 */
export const AUTHORSHIP_VERSION = 2;

export interface LineAuthor {
  line: number;
  /** The commit that wrote the line, and where the line sat in it. */
  sha: string;
  originLine: number;
  originPath: string;
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
      hit = (async () => {
        const meta = await commitMeta(this.repo, sha);
        const by = classifyCommit(meta, (await roots).has(sha), this.identities);
        // 0003 calls every root commit a template, so scaffolded dependencies are
        // never asked about. For lines that overstates it the other way: the first
        // commit of a project you imported is often your own code. Said plainly
        // instead: not confirmed, and you can say "I wrote these".
        if (by.rule === 'root commit' && this.identities.mine.has(meta.authorEmail.trim().toLowerCase())) {
          return { authorship: 'unknown', rule: 'your root commit: a scaffold or your own code', actor: 'first commit, author not confirmed' };
        }
        return by;
      })();
      this.cache.set(sha, hit);
    }
    return hit;
  }
}

/**
 * A label covers a line when it names the commit that wrote it and the line's
 * place there, so it holds in every later commit that leaves the line alone.
 * Labels stored before that (by the commit being viewed) still match there.
 */
const covers = (x: LineLabel, l: LineAuthor, viewSha: string, viewPath: string) =>
  (x.sha === l.sha && x.path === l.originPath && l.originLine >= x.lineStart && l.originLine <= x.lineEnd) ||
  (x.sha === viewSha && x.path === viewPath && l.line >= x.lineStart && l.line <= x.lineEnd);

function applyLabels(lines: LineAuthor[], labels: readonly LineLabel[], sha: string, path: string): LineAuthor[] {
  if (labels.length === 0) return lines;
  return lines.map((l) => {
    // The most recent relabel covering the line wins: labels arrive oldest first.
    const label = [...labels].reverse().find((x) => covers(x, l, sha, path));
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
  const blamed = await blameOrigins(repo, sha, path, start, end);
  const lines: LineAuthor[] = [];
  for (let n = start; n <= end; n += 1) {
    const origin = blamed.get(n);
    if (origin === undefined) continue;
    const by = await classifier.classify(origin.sha);
    lines.push({
      line: n,
      sha: origin.sha,
      originLine: origin.line,
      originPath: origin.path,
      authorship: by.authorship,
      actor: by.actor,
      relabelled: false,
    });
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
    lines.push({ line: n, sha, originLine: n, originPath: path, authorship: by.authorship, actor: by.actor, relabelled: false });
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
