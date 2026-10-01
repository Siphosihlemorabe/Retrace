/**
 * The code a question is about, with line numbers, read from the local clone
 * at the moment it is needed. Sent to the model (with consent) and shown to
 * the builder, but never stored (G11).
 */
import { showFile, type Repo } from '../git/index.js';

export const CONTEXT_LINES = 15;
/** Enough to understand a hit; more mostly costs tokens. */
const MAX_LINES = 80;

export interface Excerpt {
  from: number;
  to: number;
  /** "12  SELECT …" — numbered, so model and builder can name lines. */
  text: string;
  lines: { n: number; text: string }[];
}

export async function excerptAt(repo: Repo, sha: string, path: string, start: number, end: number): Promise<Excerpt | null> {
  const content = await showFile(repo, sha, path);
  if (content === null) return null;
  const all = content.replace(/\n$/, '').split('\n');
  const from = Math.max(1, start - CONTEXT_LINES);
  const to = Math.min(all.length, Math.max(end + CONTEXT_LINES, from), from + MAX_LINES - 1);
  const lines = all.slice(from - 1, to).map((text, i) => ({ n: from + i, text }));
  const width = String(to).length;
  return { from, to, lines, text: lines.map((l) => `${String(l.n).padStart(width)}  ${l.text}`).join('\n') };
}
