import { describe, expect, test } from 'vitest';

import { diffManifests, majorOf, parseManifest } from './manifest.js';

describe('parseManifest', () => {
  test('reads all three dependency sections', () => {
    const manifest = parseManifest(
      JSON.stringify({
        dependencies: { hono: '^4.0.0' },
        devDependencies: { vitest: '^5.0.0' },
        peerDependencies: { react: '^19.0.0' },
      }),
    );

    expect(manifest?.get('hono')).toEqual({
      name: 'hono',
      range: '^4.0.0',
      kind: 'runtime',
    });
    expect(manifest?.get('vitest')?.kind).toBe('dev');
    expect(manifest?.get('react')?.kind).toBe('peer');
  });

  // A manifest can be malformed at any commit in history — mid-merge,
  // mid-rebase, mid-typo. One bad revision must not abort the walk.
  test.each([
    ['absent', null],
    ['not json', '{ this is not json'],
    ['an array', '[]'],
    ['a bare string', '"hello"'],
    ['empty', ''],
  ])('returns null for %s rather than throwing', (_label, source) => {
    expect(parseManifest(source)).toBeNull();
  });

  test('ignores non-string version ranges', () => {
    const manifest = parseManifest(
      JSON.stringify({ dependencies: { good: '^1.0.0', bad: { nested: true } } }),
    );
    expect(manifest?.has('good')).toBe(true);
    expect(manifest?.has('bad')).toBe(false);
  });

  test('tolerates a manifest with no dependencies at all', () => {
    const manifest = parseManifest(JSON.stringify({ name: 'x', version: '1.0.0' }));
    expect(manifest?.size).toBe(0);
  });
});

describe('majorOf', () => {
  test.each([
    ['^1.2.3', 1],
    ['~2.0.0', 2],
    ['>=3.0.0 <4', 3],
    ['4.1.0', 4],
    ['workspace:*', null],
    ['*', null],
    ['', null],
  ])('%s → %s', (range, expected) => {
    expect(majorOf(range)).toBe(expected);
  });
});

describe('diffManifests', () => {
  const before = parseManifest(
    JSON.stringify({ dependencies: { prisma: '^5.0.0', hono: '^4.0.0' } }),
  );

  test('reports adds and removes', () => {
    const after = parseManifest(
      JSON.stringify({ dependencies: { 'drizzle-orm': '^0.45.0', hono: '^4.0.0' } }),
    );
    const diff = diffManifests(before, after);

    expect(diff.added.map((d) => d.name)).toEqual(['drizzle-orm']);
    expect(diff.removed.map((d) => d.name)).toEqual(['prisma']);
  });

  test('a first manifest is all additions, not a phantom diff', () => {
    const diff = diffManifests(null, before);
    expect(diff.added).toHaveLength(2);
    expect(diff.removed).toHaveLength(0);
  });

  test('reports major bumps but not patch or minor churn', () => {
    const bumped = parseManifest(
      JSON.stringify({ dependencies: { prisma: '^6.0.0', hono: '^4.9.1' } }),
    );
    const diff = diffManifests(before, bumped);

    expect(diff.majorBumped).toHaveLength(1);
    expect(diff.majorBumped[0]).toMatchObject({ name: 'prisma', fromMajor: 5, toMajor: 6 });
  });

  test('an unparseable revision yields no diff rather than mass removal', () => {
    const diff = diffManifests(before, parseManifest('{ broken'));
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});
