/**
 * Each provider against a fake: a stub `claude` script, and fake HTTP servers
 * standing in for Ollama and the Anthropic API. No real model is called.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { anthropicApi, claudeCli, ollama, ProviderError } from './providers.js';

let dir: string;
const saved = new Map<string, string | undefined>();
const setEnv = (k: string, v: string) => {
  if (!saved.has(k)) saved.set(k, process.env[k]);
  process.env[k] = v;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retrace-providers-'));
});
afterAll(async () => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

/** A fake HTTP server; returns its base URL. */
async function fakeServer(handler: (path: string, body: unknown) => unknown): Promise<{ url: string; server: Server; seen: unknown[] }> {
  const seen: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw === '' ? null : JSON.parse(raw);
      seen.push(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(handler(req.url ?? '', body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, server, seen };
}

describe('claude-cli', () => {
  test('passes tools off, one turn, our system prompt, and the input on stdin', async () => {
    // The stub echoes what it received inside a Claude Code-shaped envelope.
    const stub = join(dir, 'fake-claude.mjs');
    await writeFile(
      stub,
      `import { readFileSync } from 'node:fs';
let input = ''; process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const args = process.argv.slice(2);
  const sys = readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8');
  process.stdout.write(JSON.stringify({
    is_error: false,
    result: JSON.stringify({ args, sys, input, cwd: process.cwd() }),
    total_cost_usd: 0.0021,
    usage: { input_tokens: 400, output_tokens: 20 },
    modelUsage: { 'claude-opus-5-5[1m]': {} },
  }));
});`,
    );
    setEnv('RETRACE_CLAUDE_CMD', JSON.stringify(['node', stub]));

    const result = await claudeCli(null).complete({ system: 'Return JSON only.', input: 'What does line 3 do?' });
    const echoed = JSON.parse(result.text) as { args: string[]; sys: string; input: string; cwd: string };
    // Never from inside a project: Claude Code would load its CLAUDE.md into the prompt.
    expect(echoed.cwd).not.toBe(process.cwd());
    expect(echoed.args.slice(echoed.args.indexOf('--tools'), echoed.args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(echoed.args).toContain('-p');
    expect(echoed.args.slice(echoed.args.indexOf('--max-turns'), echoed.args.indexOf('--max-turns') + 2)).toEqual(['--max-turns', '1']);
    expect(echoed.sys).toBe('Return JSON only.');
    expect(echoed.input).toBe('What does line 3 do?');
    expect(result).toMatchObject({ model: 'claude-opus-5-5', costUsd: 0.0021, inputTokens: 400, outputTokens: 20 });
  });

  test('an error envelope (e.g. not logged in) becomes a ProviderError', async () => {
    const stub = join(dir, 'fake-claude-error.mjs');
    await writeFile(stub, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' })));`);
    setEnv('RETRACE_CLAUDE_CMD', JSON.stringify(['node', stub]));
    await expect(claudeCli(null).complete({ system: 's', input: 'i' })).rejects.toThrow(/Not logged in/);
  });
});

describe('ollama', () => {
  test('sends system and user messages, asks for JSON, reads the reply', async () => {
    const fake = await fakeServer(() => ({ message: { content: '{"ok":true}' }, model: 'llama3.1', prompt_eval_count: 50, eval_count: 5 }));
    setEnv('OLLAMA_URL', fake.url);
    const result = await ollama(null).complete({ system: 'sys', input: 'hi' });
    expect(result).toMatchObject({ text: '{"ok":true}', model: 'llama3.1', inputTokens: 50, outputTokens: 5 });
    expect(fake.seen[0]).toMatchObject({ format: 'json', stream: false, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] });
    fake.server.close();
  });

  test('an unreachable Ollama is a clear error', async () => {
    setEnv('OLLAMA_URL', 'http://127.0.0.1:9');
    await expect(ollama(null).complete({ system: 's', input: 'i' })).rejects.toThrow(ProviderError);
  });
});

describe('anthropic-api', () => {
  test('calls messages.create with the system prompt and reads text blocks', async () => {
    const fake = await fakeServer(() => ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 4 },
    }));
    setEnv('ANTHROPIC_BASE_URL', fake.url);
    setEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    const result = await anthropicApi(null).complete({ system: 'sys', input: 'hi' });
    expect(result).toMatchObject({ text: '{"ok":true}', model: 'claude-opus-5', inputTokens: 30, outputTokens: 4 });
    expect(fake.seen[0]).toMatchObject({ model: 'claude-opus-5', system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    fake.server.close();
  });
});
