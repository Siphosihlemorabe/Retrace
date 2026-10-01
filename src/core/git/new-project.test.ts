import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { commitPositions } from './index.js';
import { createProjectFolder } from './new-project.js';

const exec = promisify(execFile);

const GIT_VARS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const;

describe('new project folder', () => {
  let parent: string;
  const saved = new Map<string, string | undefined>();

  beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), 'retrace-newproj-'));
    // Tests must not depend on the machine's git identity.
    for (const v of GIT_VARS) saved.set(v, process.env[v]);
    process.env['GIT_AUTHOR_NAME'] = 'Fixture';
    process.env['GIT_AUTHOR_EMAIL'] = 'fixture@example.com';
    process.env['GIT_COMMITTER_NAME'] = 'Fixture';
    process.env['GIT_COMMITTER_EMAIL'] = 'fixture@example.com';
  });

  afterAll(async () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(parent, { recursive: true, force: true });
  });

  test('creates a git repo with one empty commit, so goals can be set before any code', async () => {
    const repo = await createProjectFolder(join(parent, 'bookings-api'));
    expect((await commitPositions(repo)).total).toBe(1);
    const { stdout } = await exec('git', ['-C', repo.path, 'ls-files']);
    expect(stdout.trim()).toBe('');
  });

  test('refuses a folder that already has files: that is an existing project', async () => {
    const dir = join(parent, 'existing');
    await createProjectFolder(dir);
    await writeFile(join(dir, 'index.ts'), 'export {};\n');
    await expect(createProjectFolder(dir)).rejects.toThrow(/already has files/);
  });
});
