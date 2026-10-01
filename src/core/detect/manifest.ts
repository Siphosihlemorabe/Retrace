/**
 * package.json parsing and diffing.
 *
 * Every function here tolerates garbage: a manifest can be malformed at any
 * commit in history (mid-merge, mid-rebase, mid-typo) and one bad revision must
 * not abort a walk over a thousand good ones.
 */

export type DepKind = 'runtime' | 'dev' | 'peer';

export interface Dep {
  name: string;
  range: string;
  kind: DepKind;
}

export type Manifest = ReadonlyMap<string, Dep>;

const SECTIONS: ReadonlyArray<readonly [string, DepKind]> = [
  ['dependencies', 'runtime'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
];

/** Returns null for absent or unparseable manifests — never throws. */
export function parseManifest(source: string | null): Manifest | null {
  if (source === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const root = parsed as Record<string, unknown>;
  const deps = new Map<string, Dep>();

  for (const [key, kind] of SECTIONS) {
    const section = root[key];
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      continue;
    }
    for (const [name, range] of Object.entries(section as Record<string, unknown>)) {
      if (typeof range !== 'string') continue;
      // A package listed in several sections keeps the last one seen; runtime
      // vs dev matters less here than knowing it is present at all.
      deps.set(name, { name, range, kind });
    }
  }

  return deps;
}

/**
 * First integer in a range. `^1.2.3` → 1, `>=2.0.0 <3` → 2, `workspace:*` → null.
 * Approximate on purpose: this only feeds a "did the major move" signal.
 */
export function majorOf(range: string): number | null {
  const match = /(\d+)/.exec(range);
  if (match?.[1] === undefined) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isNaN(value) ? null : value;
}

export interface MajorBump {
  name: string;
  from: string;
  to: string;
  fromMajor: number;
  toMajor: number;
}

export interface ManifestDiff {
  added: Dep[];
  removed: Dep[];
  majorBumped: MajorBump[];
}

export const EMPTY_DIFF: ManifestDiff = { added: [], removed: [], majorBumped: [] };

export function diffManifests(
  before: Manifest | null,
  after: Manifest | null,
): ManifestDiff {
  if (after === null) return { added: [], removed: [], majorBumped: [] };

  const added: Dep[] = [];
  const removed: Dep[] = [];
  const majorBumped: MajorBump[] = [];

  for (const [name, dep] of after) {
    const previous = before?.get(name);
    if (previous === undefined) {
      added.push(dep);
      continue;
    }
    const fromMajor = majorOf(previous.range);
    const toMajor = majorOf(dep.range);
    if (fromMajor !== null && toMajor !== null && toMajor > fromMajor) {
      majorBumped.push({
        name,
        from: previous.range,
        to: dep.range,
        fromMajor,
        toMajor,
      });
    }
  }

  if (before !== null) {
    for (const [name, dep] of before) {
      if (!after.has(name)) removed.push(dep);
    }
  }

  return { added, removed, majorBumped };
}
