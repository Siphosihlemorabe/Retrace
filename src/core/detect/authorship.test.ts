import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  AUTHORSHIP_CLASSES,
  classifyCommit,
  coAuthors,
  knownNonHuman,
  type IdentitySet,
} from './authorship.js';
import { KIND_BONUS } from './rank.js';

const ME = 'me@example.com';
const identities: IdentitySet = {
  mine: new Set([ME]),
  others: new Set(['colleague@example.com']),
};

const commit = (over: Partial<{ authorName: string; authorEmail: string; subject: string; body: string }>) => ({
  authorName: 'Someone',
  authorEmail: 'someone@example.com',
  subject: 'Change things',
  body: '',
  ...over,
});

// Real identities from the corpus, so the catalogue is tested on what it was
// seeded from rather than on invented strings.
const LOVABLE_BOT = {
  authorName: 'gpt-engineer-app[bot]',
  authorEmail: '159125892+gpt-engineer-app[bot]@users.noreply.github.com',
  subject: 'Changes',
  // Lovable credits the human driving the session on every agent commit.
  body: 'Co-authored-by: Siphosihlemorabe <152267979+Siphosihlemorabe@users.noreply.github.com>',
};

describe('classifyCommit', () => {
  test('a Lovable template root is a template, named from its subject', () => {
    const result = classifyCommit(
      commit({ authorName: 'Lovable', subject: 'template: vite_react_shadcn_ts_2026-04-20' }),
      true,
      identities,
    );
    expect(result).toEqual({
      authorship: 'template',
      rule: 'template subject',
      actor: 'vite_react_shadcn_ts_2026-04-20',
    });
  });

  test('any root commit is a template, even one the builder wrote', () => {
    expect(classifyCommit(commit({ authorEmail: ME }), true, identities).authorship).toBe(
      'template',
    );
  });

  test('the Lovable agent is an agent, even though it credits the builder', () => {
    const result = classifyCommit(LOVABLE_BOT, false, identities);
    expect(result.authorship).toBe('agent');
    expect(result.actor).toBe('Lovable');
  });

  test('dependency bots are automation, not agents', () => {
    expect(
      classifyCommit(commit({ authorName: 'dependabot[bot]' }), false, identities).authorship,
    ).toBe('automation');
  });

  test('the builder with a Claude trailer is builder_with_agent, whatever the case of the key', () => {
    for (const key of ['Co-Authored-By', 'Co-authored-by']) {
      const result = classifyCommit(
        commit({
          authorEmail: 'ME@example.com',
          body: `Fix the thing\n\n${key}: Claude Opus 5 <noreply@anthropic.com>`,
        }),
        false,
        identities,
      );
      expect(result.authorship).toBe('builder_with_agent');
      expect(result.actor).toBe('Claude');
    }
  });

  test('a human co-author is not an agent', () => {
    const result = classifyCommit(
      commit({ authorEmail: ME, body: 'Co-authored-by: TUMO OLO <tumo@example.com>' }),
      false,
      identities,
    );
    expect(result.authorship).toBe('builder');
  });

  test('confirmed others are other_human; everyone else is unknown, not assumed', () => {
    expect(
      classifyCommit(commit({ authorEmail: 'colleague@example.com' }), false, identities)
        .authorship,
    ).toBe('other_human');
    expect(classifyCommit(commit({}), false, identities).authorship).toBe('unknown');
    // An unrecognised bot is asked about once rather than guessed at.
    expect(
      classifyCommit(commit({ authorName: 'some-new-agent[bot]' }), false, identities).authorship,
    ).toBe('unknown');
  });
});

describe('helpers', () => {
  test('coAuthors parses every trailer and lower-cases emails', () => {
    expect(coAuthors('x\n\nCo-Authored-By: A <A@X.com>\nCo-authored-by: B <b@y.com>')).toEqual([
      { name: 'A', email: 'a@x.com' },
      { name: 'B', email: 'b@y.com' },
    ]);
  });

  test('knownNonHuman recognises catalogue identities and nobody else', () => {
    expect(knownNonHuman(LOVABLE_BOT.authorName, LOVABLE_BOT.authorEmail)).toBe('Lovable');
    expect(knownNonHuman('Siphosihlemorabe', 'someone@gmail.com')).toBeNull();
  });
});

/**
 * One vocabulary across code and schema, with no mapping layer (0001
 * follow-up). `kind` and `introduced_by` are text columns, so TypeScript cannot
 * catch drift; this reads the CHECK constraints straight from the migrations.
 */
describe('vocabulary matches the schema', () => {
  const migrations = readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join('migrations', f), 'utf8'))
    .join('\n');

  const allowed = (constraint: string): string[] => {
    const match = new RegExp(`"${constraint}" CHECK \\([^)]*IN \\(([^)]*)\\)`).exec(migrations);
    if (match === null) throw new Error(`constraint ${constraint} not found in migrations`);
    return (match[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
  };

  test('authorship classes are exactly candidates_introduced_by', () => {
    expect([...AUTHORSHIP_CLASSES].sort()).toEqual(allowed('candidates_introduced_by').sort());
  });

  test('and exactly outcome_sightings_authorship', () => {
    expect([...AUTHORSHIP_CLASSES].sort()).toEqual(allowed('outcome_sightings_authorship').sort());
  });

  test('every detector kind is allowed by candidates_kind', () => {
    const kinds = allowed('candidates_kind');
    for (const kind of Object.keys(KIND_BONUS)) expect(kinds).toContain(kind);
  });
});
