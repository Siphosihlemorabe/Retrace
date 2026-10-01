/**
 * Asking a model for structured JSON (0009): cache first, then the daily cap,
 * then the call, then a schema check. Every outcome is logged in `llm_calls`.
 *
 * Callers never get a half-valid answer. A result either matches the schema
 * (after at most one retry) or the caller gets `{ ok: false }` and uses its
 * rule-based fallback — the builder's chosen behaviour when the model is
 * unavailable (0009 decision 1).
 */
import { createHash } from 'node:crypto';

import { and, count, eq, gte } from 'drizzle-orm';
import type { z } from 'zod';

import { analysisCache, llmCalls } from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import { providerFromEnv, ProviderError, type Provider } from './providers.js';

export { providerFromEnv, type Provider } from './providers.js';

export const DEFAULT_DAILY_CALLS = 20;

export type JsonResult<T> =
  | { ok: true; value: T; cached: boolean; provider: string; model: string | null; cacheKey: string }
  | { ok: false; reason: 'off' | 'capped' | 'failed'; message: string };

export interface JsonRequest<T> {
  /** What the call is for, e.g. "question" — part of the cache key and the log. */
  purpose: string;
  /** Bumped whenever the prompt's meaning changes (G13, G17). */
  promptVersion: number;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  /** Everything that identifies *what* was asked about: repo, SHA, path, lines… */
  cacheParts: readonly (string | number)[];
  repoId?: string;
  sha?: string;
  maxTokens?: number;
}

export function dailyCap(): number {
  const raw = Number(process.env['RETRACE_LLM_DAILY_CALLS'] ?? DEFAULT_DAILY_CALLS);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_DAILY_CALLS;
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Model calls made today (cache hits don't count against the cap). */
export async function callsToday(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(llmCalls)
    .where(and(eq(llmCalls.userId, userId), eq(llmCalls.cacheHit, false), gte(llmCalls.createdAt, startOfToday())));
  return row?.n ?? 0;
}

/** Pull a JSON object out of a reply, tolerating ```json fences or a stray sentence. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error('no JSON object in the reply');
  }
}

export async function completeJson<T>(
  db: Db,
  userId: string,
  req: JsonRequest<T>,
  provider: Provider | null = providerFromEnv(),
): Promise<JsonResult<T>> {
  if (provider === null) return { ok: false, reason: 'off', message: 'No model is connected (RETRACE_LLM=off).' };

  const cacheKey = createHash('sha256')
    .update(JSON.stringify([req.purpose, req.promptVersion, provider.name, provider.model, ...req.cacheParts]))
    .digest('hex');
  const log = (entry: Partial<typeof llmCalls.$inferInsert> & { cacheHit: boolean; ok: boolean }) =>
    db.insert(llmCalls).values({ userId, purpose: req.purpose, provider: provider.name, model: provider.model, cacheKey, ...entry });

  // 1. The cache: the same code, prompt and model are never paid for twice.
  const [hit] = await db.select().from(analysisCache).where(eq(analysisCache.cacheKey, cacheKey));
  if (hit !== undefined) {
    const parsed = req.schema.safeParse(hit.result);
    if (parsed.success) {
      await log({ cacheHit: true, ok: true, model: hit.model });
      return { ok: true, value: parsed.data, cached: true, provider: provider.name, model: hit.model, cacheKey };
    }
  }

  // 2. The daily cap.
  const cap = dailyCap();
  if ((await callsToday(db, userId)) >= cap) {
    return { ok: false, reason: 'capped', message: `Today's ${cap} model calls are used. Using simpler questions until tomorrow.` };
  }

  // 3. The call, with one retry if the reply doesn't fit the schema.
  const started = Date.now();
  let input = req.input;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let result;
    try {
      result = await provider.complete({ system: req.system, input, ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }) });
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : String(error);
      await log({ cacheHit: false, ok: false, error: message.slice(0, 500), durationMs: Date.now() - started });
      return { ok: false, reason: 'failed', message };
    }

    let problem: string;
    try {
      const parsed = req.schema.safeParse(extractJson(result.text));
      if (parsed.success) {
        await db
          .insert(analysisCache)
          .values({
            cacheKey,
            kind: req.purpose,
            repoId: req.repoId ?? null,
            sha: req.sha ?? null,
            promptVersion: req.promptVersion,
            analysisVersion: 1,
            model: result.model ?? provider.model ?? provider.name,
            result: parsed.data as object,
            inputTokens: result.inputTokens ?? null,
            outputTokens: result.outputTokens ?? null,
          })
          .onConflictDoNothing();
        await log({
          cacheHit: false,
          ok: true,
          model: result.model ?? provider.model,
          durationMs: Date.now() - started,
          inputTokens: result.inputTokens ?? null,
          outputTokens: result.outputTokens ?? null,
          costUsd: result.costUsd === undefined ? null : result.costUsd.toFixed(6),
        });
        return { ok: true, value: parsed.data, cached: false, provider: provider.name, model: result.model ?? provider.model, cacheKey };
      }
      problem = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } catch (error) {
      problem = (error as Error).message;
    }

    if (attempt === 2) {
      await log({ cacheHit: false, ok: false, error: `invalid reply: ${problem}`.slice(0, 500), durationMs: Date.now() - started });
      return { ok: false, reason: 'failed', message: 'The model’s reply did not fit what was asked for.' };
    }
    // Rejected, never coerced (G16): say what was wrong and ask once more.
    input = `${req.input}\n\nYour previous reply did not match the required JSON (${problem}). Reply with the JSON object only.`;
  }
  return { ok: false, reason: 'failed', message: 'unreachable' };
}

/** What the settings screen shows. */
export async function llmStatus(db: Db, userId: string) {
  let provider: Provider | null = null;
  let error: string | null = null;
  try {
    provider = providerFromEnv();
  } catch (e) {
    error = (e as Error).message;
  }
  return {
    provider: provider?.name ?? 'off',
    model: provider?.model ?? null,
    sendsCodeOffMachine: provider?.sendsCodeOffMachine ?? false,
    callsToday: await callsToday(db, userId),
    dailyCap: dailyCap(),
    error,
  };
}
