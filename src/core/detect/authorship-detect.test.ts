/**
 * 0003 end to end over a fixture shaped like the real corpus: a Lovable
 * template root with a fictional date, an agent swap in a busy commit, the
 * builder's own choices with and without a Claude trailer, a dependabot bump,
 * and a colleague's swap.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createFixtureRepo, type FixtureRepo } from '../../test/fixture-repo.js';
import { openRepo } from '../git/index.js';
import type { IdentitySet } from './authorship.js';
import { detectDependencyDecisions } from './dependency.js';
import { rank, type RankResult } from './rank.js';

const ME = { name: 'Me', email: 'me@example.com' };
const AGENT = {
  name: 'gpt-engineer-app[bot]',
  email: '159125892+gpt-engineer-app[bot]@users.noreply.github.com',
};
const COLLEAGUE = { name: 'Colleague', email: 'colleague@example.com' };
const identities: IdentitySet = { mine: new Set([ME.email]), others: new Set([COLLEAGUE.email]) };

const pkg = (deps: Record<string, string>) =>
  JSON.stringify({ name: 'f', version: '1.0.0', dependencies: deps }, null, 2);

let fixture: FixtureRepo;
let result: RankResult;

beforeAll(async () => {
  fixture = await createFixtureRepo();
  const base = { react: '^19.0.0' };

  // Every Lovable root is dated 2025-01-01, whenever the project really began.
  await fixture.write('package.json', pkg({ ...base, '@tanstack/react-router': '^1.0.0' }));
  await fixture.write('src/router.ts', `import { createRouter } from '@tanstack/react-router';\n`);
  await fixture.commit('template: tanstack_start_ts_2026-05-06', {
    author: { name: 'Lovable', email: 'noreply@lovable.dev' },
  });

  // The agent swaps the router inside a busy commit called "Changes".
  await fixture.write('package.json', pkg({ ...base, 'react-router-dom': '^7.0.0' }));
  for (const f of ['src/router.ts', 'src/a.ts', 'src/b.ts']) {
    await fixture.write(f, `import { Link } from 'react-router-dom';\n`);
  }
  for (let i = 0; i < 30; i += 1) await fixture.write(`src/gen-${i}.ts`, `export {};\n`);
  await fixture.commit('Changes', {
    day: 490,
    author: AGENT,
    body: 'Co-authored-by: Me <me@example.com>',
  });

  // The builder's own choice, landed alone.
  await fixture.write('package.json', pkg({ ...base, 'react-router-dom': '^7.0.0', zod: '^3.0.0' }));
  await fixture.write('src/schema.ts', `import { z } from 'zod';\n`);
  await fixture.commit('validate input', { day: 491, author: ME });

  // The builder again, with Claude as co-author.
  await fixture.write(
    'package.json',
    pkg({ ...base, 'react-router-dom': '^7.0.0', zod: '^3.0.0', pino: '^9.0.0' }),
  );
  await fixture.write('src/log.ts', `import pino from 'pino';\n`);
  await fixture.commit('add logging', {
    day: 492,
    author: ME,
    body: 'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
  });

  // A colleague swaps the logger. Real, deliberate — and not the builder's.
  await fixture.write(
    'package.json',
    pkg({ ...base, 'react-router-dom': '^7.0.0', zod: '^3.0.0', winston: '^3.0.0' }),
  );
  await fixture.write('src/log.ts', `import winston from 'winston';\n`);
  await fixture.commit('switch logger', { day: 493, author: COLLEAGUE });

  // Dependabot bumps a major. Not a decision anyone made.
  await fixture.write(
    'package.json',
    pkg({ react: '^20.0.0', 'react-router-dom': '^7.0.0', zod: '^3.0.0', winston: '^3.0.0', dayjs: '^1.0.0' }),
  );
  await fixture.write('src/date.ts', `import dayjs from 'dayjs';\n`);
  await fixture.commit('chore(deps): bump', {
    day: 494,
    author: { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' },
  });

  const repo = await openRepo(fixture.dir);
  result = rank((await detectDependencyDecisions(repo, { identities })).candidates);
}, 120_000);

afterAll(async () => {
  await fixture?.remove();
});

const find = (name: string) => result.ranked.find((c) => c.packageName === name);

describe('authorship in detection', () => {
  test('the agent swap still surfaces — it is not filtered out — and is marked as the agent', () => {
    const swap = find('react-router-dom');
    expect(swap?.kind).toBe('replacement');
    expect(swap?.suppressed).toBeNull();
    expect(swap?.authorship).toMatchObject({ authorship: 'agent', actor: 'Lovable' });
  });

  test("the builder's own commits are builder, and builder_with_agent with a Claude trailer", () => {
    expect(find('zod')?.authorship.authorship).toBe('builder');
    expect(find('pino')?.authorship).toMatchObject({
      authorship: 'builder_with_agent',
      actor: 'Claude',
    });
  });

  test("a colleague's swap is suppressed as someone else's, with the reason kept", () => {
    const swap = find('winston');
    expect(swap?.authorship.authorship).toBe('other_human');
    expect(swap?.suppressed).toBe('someone else’s change');
    expect(swap?.suppressedDetail).toContain(COLLEAGUE.email);
  });

  test('a dependabot change is suppressed as automated', () => {
    expect(find('dayjs')?.suppressed).toBe('automated change');
  });

  test('the template root is a template and stays suppressed', () => {
    // Its later removal is consumed by the agent's swap; its arrival is the template's.
    const root = find('@tanstack/react-router');
    expect(root?.kind).toBe('dependency_choice');
    expect(root?.authorship).toMatchObject({
      authorship: 'template',
      actor: 'tanstack_start_ts_2026-05-06',
    });
    expect(root?.suppressed).toBe('not deliberate');
  });

  test('position, not date: the agent swap is commit 2 of 6, whatever it says it was', () => {
    const swap = find('react-router-dom');
    expect(swap?.commitIndex).toBe(2);
    expect(swap?.commitCount).toBe(6);
    expect(swap?.tests.deliberate.why).toContain('commit 2 of 6');
  });

  test('calibration counts surfaced candidates by who made them', () => {
    expect(result.summary.surfacedBy.agent).toBe(1);
    expect(result.summary.suppressed['someone else’s change']).toBe(1);
    expect(result.summary.suppressed['automated change']).toBeGreaterThanOrEqual(1);
  });
});
