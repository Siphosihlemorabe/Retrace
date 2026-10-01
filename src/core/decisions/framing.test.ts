/**
 * Copy checks (0003 deliverable; G4, G5). The agent frame never says "you
 * chose", never counts the agent's commits, and the wording stays inside the
 * honest limit.
 */
import { describe, expect, test } from 'vitest';

import type { Authorship } from '../detect/authorship.js';
import type { StoredCandidate } from '../detect/candidate-row.js';
import { goalTitle, questionFor } from './framing.js';

const stored = (authorship: Authorship, actor: string | null = null): StoredCandidate => ({
  id: 'id',
  repoId: 'r',
  kind: 'replacement',
  subjectKey: 'npm:react-router-dom',
  introducingSha: 'e322be8084039ac04edc511d0a6c7abb8df0c906',
  filePath: 'package.json',
  filesInCommit: 91,
  commitIndex: 5,
  commitCount: 482,
  authorship: { authorship, rule: 'r', actor },
  authorEmail: 'bot@example.com',
  score: 1,
  status: 'pending',
  skipCount: 0,
  signals: {
    packageName: 'react-router-dom',
    displaced: '@tanstack/react-router',
    category: 'router',
    categoryLabel: 'client router',
    commitSubject: 'Changes',
    commitDate: '2026-05-07T00:00:00.000Z',
    importingFiles: 23,
    tests: {
      alternative: { pass: true, why: '' },
      loadBearing: { pass: true, why: '' },
      deliberate: { pass: true, why: '' },
    },
    authorshipRule: 'r',
    authorshipActor: actor,
  },
});

const allText = (q: ReturnType<typeof questionFor>) =>
  [q.headline, ...q.details, q.prompt, q.choice, ...q.options.map((o) => o.label)].join('\n');

describe('the agent frame', () => {
  const q = questionFor(stored('agent', 'Lovable'), 1, 3);

  test('matches 0003: in your code, with [a] [k] [g] [x] [s]', () => {
    expect(q.headline).toBe('1 of 3 this week · replaced  npm:@tanstack/react-router → npm:react-router-dom');
    expect(q.details).toEqual([
      'e322be8  "Changes" · made by your agent (Lovable) · 91 files',
      'commit 5 of 482',
    ]);
    expect(q.prompt).toBe("This swap is in your code. What's the story?");
    expect(q.options.map((o) => o.key)).toEqual(['a', 'k', 'g', 'x', 's']);
    expect(q.choice).toBe('keep react-router-dom over @tanstack/react-router');
  });

  test('never says the builder chose it, and never tallies the agent (G4, G5)', () => {
    const text = allText(q).toLowerCase();
    expect(text).not.toMatch(/you chose|your choice|why did you/);
    // "commit 5 of 482" is position; a tally would be "N of M commits".
    expect(text).not.toMatch(/\d+\s+of\s+\d+\s+commits/);
  });

  test('roles: [a] directed, [k] kept — never made', () => {
    const roles = q.options.flatMap((o) => (o.action.kind === 'decision' ? [o.action.role] : []));
    expect(roles).toEqual(['directed', 'kept']);
  });
});

describe('the builder frame', () => {
  test("asks about the builder's own choice, with 0002's answers", () => {
    const q = questionFor(stored('builder'), 2, 3);
    expect(q.prompt).toBe('What happened here?');
    expect(q.options.map((o) => o.key)).toEqual(['d', 'g', 'n', 'x', 's']);
    expect(q.details[0]).toContain('made by you');
  });
});

describe('copy stays inside the honest limit (G5)', () => {
  test.each<Authorship>(['builder', 'builder_with_agent', 'agent'])('%s frame', (a) => {
    const text = allText(questionFor(stored(a, 'Claude'), 1, 1)).toLowerCase();
    expect(text).not.toMatch(/\b(verified|proven|guaranteed|certified)\b/);
    expect(text).not.toMatch(/really understand|fail/);
  });

  test('a learning goal is about the change, not just a package name', () => {
    expect(goalTitle(stored('agent'))).toBe(
      'What changed when @tanstack/react-router was replaced by react-router-dom',
    );
  });
});
