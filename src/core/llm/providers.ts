/**
 * The model providers (0009). One interface, three ways to reach a model, chosen
 * with RETRACE_LLM in .env:
 *
 * - `claude-cli` (default): the builder's own Claude Code, run as
 *   `claude -p` with every tool turned off, so the model sees only what it is
 *   handed and cannot read files or run commands.
 * - `ollama`: a model on this machine. Nothing leaves it.
 * - `anthropic-api`: the Anthropic API with ANTHROPIC_API_KEY.
 *
 * This file and index.ts are the only code that talks to a model (G15).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

export type ProviderName = 'claude-cli' | 'ollama' | 'anthropic-api';

export interface CompletionRequest {
  system: string;
  input: string;
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  /** The model that actually answered, when the provider says. */
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface Provider {
  name: ProviderName;
  /** Whether code sent to this provider leaves the builder's machine (consent is asked per repo). */
  sendsCodeOffMachine: boolean;
  /** The model asked for, if set (RETRACE_LLM_MODEL); otherwise the provider's default. */
  model: string | null;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {}

// ---------------------------------------------------------------------------

/** Run a command with stdin, collecting stdout. Windows `.cmd` shims need a shell. */
function run(cmd: string, args: string[], stdin: string, timeoutMs: number, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32';
    // With a shell, Node joins arguments with spaces, so an empty argument
    // vanishes and a path with spaces splits. Quote each one.
    const quoted = shell ? args.map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
    const child = spawn(cmd, quoted, { shell, windowsHide: true, ...(cwd === undefined ? {} : { cwd }) });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ProviderError(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ProviderError(`could not start ${cmd}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim() !== '') resolve(out);
      else reject(new ProviderError(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(stdin);
  });
}

/**
 * The builder's Claude Code. Our own short system prompt replaces Claude
 * Code's default, which measured about 8× cheaper per call on 2026-10-01
 * ($0.002 vs $0.017 for a trivial reply). `--bare` is not used: it skips the
 * login.
 */
export function claudeCli(model: string | null): Provider {
  // RETRACE_CLAUDE_CMD (a JSON array) lets tests substitute a fake `claude`.
  const configured = process.env['RETRACE_CLAUDE_CMD'];
  const [cmd, ...prefix] = configured ? (JSON.parse(configured) as string[]) : ['claude'];
  return {
    name: 'claude-cli',
    sendsCodeOffMachine: true,
    model,
    async complete(req) {
      const dir = await mkdtemp(join(tmpdir(), 'retrace-llm-'));
      try {
        const promptFile = join(dir, 'system.txt');
        await writeFile(promptFile, req.system, 'utf8');
        const args = [
          ...prefix,
          '-p',
          '--output-format',
          'json',
          '--tools',
          '',
          '--max-turns',
          '1',
          '--system-prompt-file',
          promptFile,
          ...(model === null ? [] : ['--model', model]),
        ];
        // Run from an empty folder. From inside a project, Claude Code also loads
        // that project's CLAUDE.md into the prompt: measured 6,414 input tokens
        // and $0.052 for a one-line reply, against ~500 and $0.002 from an empty
        // folder. It would also send the project's instructions to the model.
        const raw = await run(cmd as string, args, req.input, 240_000, dir);
        let envelope: {
          is_error?: boolean;
          result?: string;
          total_cost_usd?: number;
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          modelUsage?: Record<string, unknown>;
        };
        try {
          envelope = JSON.parse(raw) as typeof envelope;
        } catch {
          throw new ProviderError(`claude returned something that is not JSON: ${raw.slice(0, 200)}`);
        }
        if (envelope.is_error === true || typeof envelope.result !== 'string') {
          throw new ProviderError(`claude: ${String(envelope.result ?? 'no result').slice(0, 300)}`);
        }
        const used = Object.keys(envelope.modelUsage ?? {})[0] ?? null;
        const u = envelope.usage ?? {};
        return {
          text: envelope.result,
          model: used === null ? null : used.replace(/\[.*\]$/, ''),
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          ...(u.output_tokens === undefined ? {} : { outputTokens: u.output_tokens }),
          ...(envelope.total_cost_usd === undefined ? {} : { costUsd: envelope.total_cost_usd }),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** A model on this machine, through Ollama's HTTP API. */
export function ollama(model: string | null): Provider {
  const base = (process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const chosen = model ?? 'llama3.1';
  return {
    name: 'ollama',
    sendsCodeOffMachine: false,
    model: chosen,
    async complete(req) {
      let res: Response;
      try {
        res = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: chosen,
            stream: false,
            format: 'json',
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.input },
            ],
          }),
        });
      } catch (e) {
        throw new ProviderError(`Ollama is not reachable at ${base}: ${(e as Error).message}`);
      }
      if (!res.ok) throw new ProviderError(`Ollama returned ${res.status}`);
      const body = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; model?: string };
      return {
        text: body.message?.content ?? '',
        model: body.model ?? chosen,
        ...(body.prompt_eval_count === undefined ? {} : { inputTokens: body.prompt_eval_count }),
        ...(body.eval_count === undefined ? {} : { outputTokens: body.eval_count }),
      };
    },
  };
}

/** The Anthropic API with the builder's own key. */
export function anthropicApi(model: string | null): Provider {
  const chosen = model ?? 'claude-opus-5';
  return {
    name: 'anthropic-api',
    sendsCodeOffMachine: true,
    model: chosen,
    async complete(req) {
      const client = new Anthropic();
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: chosen,
          max_tokens: req.maxTokens ?? 8000,
          system: req.system,
          messages: [{ role: 'user', content: req.input }],
        });
      } catch (e) {
        if (e instanceof Anthropic.APIError) throw new ProviderError(`Anthropic API ${e.status ?? ''}: ${e.message}`);
        throw e;
      }
      if (message.stop_reason === 'refusal') throw new ProviderError('the model declined this request');
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return {
        text,
        model: message.model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      };
    },
  };
}

/** The provider .env asks for, or null when RETRACE_LLM=off. */
export function providerFromEnv(): Provider | null {
  const name = (process.env['RETRACE_LLM'] ?? 'claude-cli').trim();
  const model = process.env['RETRACE_LLM_MODEL']?.trim() || null;
  switch (name) {
    case 'off':
      return null;
    case 'claude-cli':
      return claudeCli(model);
    case 'ollama':
      return ollama(model);
    case 'anthropic-api':
      return anthropicApi(model);
    default:
      throw new ProviderError(`RETRACE_LLM must be claude-cli, ollama, anthropic-api or off; got "${name}"`);
  }
}
