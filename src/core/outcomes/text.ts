/**
 * Small, pure helpers the detectors share: which lines of a file are SQL, and
 * turning matching lines into ranges.
 */
import type { FileAtCommit, Hit, Via } from './types.js';

const CODE_FILE = /\.(c|m)?(t|j)sx?$/i;
export const isCodeFile = (path: string) => CODE_FILE.test(path);
export const isSqlFile = (path: string) => /\.sql$/i.test(path);
export const isTestFile = (path: string) => /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)__tests__\//i.test(path);

/** A string that is really SQL, not prose that happens to say "select". */
const SQL_SHAPE =
  /\b(SELECT\b[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|VIEW)|ALTER\s+TABLE|WITH\s+\w+\s+AS\s*\(|BEGIN\s*;|COMMIT\s*;)/i;

/**
 * The 1-based line numbers that hold SQL. In a `.sql` file that is every line
 * outside a `--` comment. In JS/TS it is only lines inside a template literal
 * or a single-line string whose contents look like SQL. That is why
 * `Array.prototype.join` or the word "join" in a comment never counts.
 */
export function sqlLines(file: FileAtCommit): Set<number> {
  const result = new Set<number>();

  if (isSqlFile(file.path)) {
    file.lines.forEach((line, i) => {
      if (line.replace(/--.*$/, '').trim() !== '') result.add(i + 1);
    });
    return result;
  }
  if (!isCodeFile(file.path)) return result;

  // Template literals, possibly spanning lines (`sql\`…\``, db.query(`…`)).
  const text = file.lines.join('\n');
  const lineAt = (offset: number) => text.slice(0, offset).split('\n').length;
  for (const m of text.matchAll(/`([^`\\]*(?:\\.[^`\\]*)*)`/g)) {
    if (!SQL_SHAPE.test(m[1] ?? '')) continue;
    const from = lineAt(m.index ?? 0);
    const to = lineAt((m.index ?? 0) + m[0].length);
    for (let n = from; n <= to; n += 1) result.add(n);
  }
  // Single-line quoted strings.
  file.lines.forEach((line, i) => {
    for (const s of line.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)) {
      if (SQL_SHAPE.test(s[2] ?? '')) result.add(i + 1);
    }
  });
  return result;
}

/** Strip a trailing `--` SQL comment, so words in comments never match. */
export const sqlCode = (line: string) => line.replace(/--.*$/, '');

/** Lines (1-based) where `pattern` matches, restricted to `within` when given. */
export function matchingLines(
  file: FileAtCommit,
  pattern: RegExp,
  within?: ReadonlySet<number>,
  clean: (line: string) => string = (l) => l,
): number[] {
  const out: number[] = [];
  file.lines.forEach((line, i) => {
    const n = i + 1;
    if (within !== undefined && !within.has(n)) return;
    if (pattern.test(clean(line))) out.push(n);
  });
  return out;
}

/** Consecutive line numbers become one range. */
export function toHits(lineNumbers: readonly number[], via: Via): Hit[] {
  const sorted = [...new Set(lineNumbers)].sort((a, b) => a - b);
  const hits: Hit[] = [];
  for (const n of sorted) {
    const last = hits[hits.length - 1];
    if (last !== undefined && n === last.end + 1) last.end = n;
    else hits.push({ start: n, end: n, via });
  }
  return hits;
}

/** Whether a hit includes at least one line the commit added. */
export const overlapsAdded = (hit: Hit, added: ReadonlySet<number>) => {
  for (let n = hit.start; n <= hit.end; n += 1) if (added.has(n)) return true;
  return false;
};
