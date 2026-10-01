/**
 * Guardrail G5 (and G2), as a test: what the product says to the builder
 * never claims more than it can back, never scores the person, and never
 * gamifies with streaks, points or badges.
 *
 * Scans every web page and CLI command, skipping comments. Per-goal progress
 * percentages are allowed (builder's decision, 2026-10-01); an overall score
 * for the person is not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const ROOTS = ['web/src', 'src/cli'];
const BANNED = /\b(verified|proven|guaranteed|certified|streaks?|badges?|points|overall score|your score)\b/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Strip comments, so explanations of the rules don't trip the rules. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('copy stays inside the honest limit (G5, G2)', () => {
  test.each(ROOTS.flatMap(files))('%s', (path) => {
    const hits = code(readFileSync(path, 'utf8'))
      .split('\n')
      .filter((line) => BANNED.test(line));
    expect(hits).toEqual([]);
  });
});
