/**
 * The local API (0006): the capture loop over JSON, for the web UI.
 *
 * Routes are thin — parse, check, delegate to core/decisions — so the browser
 * and the terminal run the same code. Request bodies are untrusted and parsed
 * with Zod at the boundary (G16); nothing past this file sees raw input.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { markShown, nextCandidates, weeklyBudget, DEFAULT_WEEKLY_LIMIT } from '../core/decisions/budget.js';
import { calibration } from '../core/decisions/calibration.js';
import {
  answerCandidate,
  candidateCostContext,
  costContextFor,
  loadCandidate,
  recordManual,
  refreshCandidates,
  reviseWithCheck,
} from '../core/decisions/capture.js';
import { isOffered, questionFor } from '../core/decisions/framing.js';
import { loadIdentitySet, recordIdentity, unresolvedIdentities } from '../core/decisions/identity.js';
import { listDecisions, missingParts } from '../core/decisions/list.js';
import { getLocalClone, listLocalClones, registerLocalClone } from '../core/decisions/local.js';
import type { DecisionShape } from '../core/decisions/record.js';
import { authorIdentities, GitError, openRepo } from '../core/git/index.js';
import type { Db } from '../db/types.js';
import type {
  AnswerResponse,
  CalibrationResponse,
  DecisionsResponse,
  IdentitiesResponse,
  ManualResponse,
  MeResponse,
  QuestionsResponse,
  RefreshResponse,
  ReposResponse,
  RepoView,
  ReviseResponse,
} from './api-types.js';
import { localOnly } from './middleware/local-only.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/** Free text, trimmed; blank means "not given", as in the CLI. */
const field = z
  .string()
  .max(4000)
  .nullable()
  .transform((v) => (v === null || v.trim() === '' ? null : v.trim()));

const Shape = z.object({
  context: field,
  optionsConsidered: field,
  choice: field,
  cost: field,
  revisitCondition: field,
});

const AnswerBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decision'), role: z.enum(['made', 'directed', 'kept']), shape: Shape }),
  z.object({ kind: z.literal('goal'), note: field }),
  z.object({
    kind: z.literal('dismiss'),
    reason: z.enum(['not_my_choice', 'not_a_choice', 'not_load_bearing']),
  }),
  z.object({ kind: z.literal('skip') }),
]);

const RepoBody = z.object({ path: z.string().trim().min(1).max(1000) });
const IdentityBody = z.object({
  email: z.string().trim().min(3).max(320),
  name: z.string().max(200).default(''),
  verdict: z.enum(['me', 'other']),
});
const ManualBody = z.object({
  shape: Shape,
  anchor: z
    .object({
      sha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
      path: z.string().trim().min(1).max(1000).optional(),
    })
    .default({}),
});
const Id = z.uuid();
const Limit = z.coerce.number().int().min(1).max(50).default(DEFAULT_WEEKLY_LIMIT);

class BadRequest extends Error {}
class NotFound extends Error {}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BadRequest('Body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

function id(c: Context, name = 'id'): string {
  const parsed = Id.safeParse(c.req.param(name));
  if (!parsed.success) throw new NotFound('No such thing.');
  return parsed.data;
}

const shapeOf = (s: z.infer<typeof Shape>): DecisionShape => s;

// ---------------------------------------------------------------------------

export interface AppOptions {
  db: Db;
  userId: string;
  login: string;
}

export function createApp({ db, userId, login }: AppOptions): Hono {
  const app = new Hono();
  app.use('/api/*', localOnly);

  const cloneOr404 = async (repoId: string) => {
    const clone = await getLocalClone(db, repoId);
    if (clone === null) throw new NotFound('No such repo.');
    return { clone, repo: await openRepo(clone.path) };
  };

  app.get('/api/me', (c) => c.json<MeResponse>({ login }));

  app.get('/api/repos', async (c) => {
    const repos = await listLocalClones(db);
    return c.json<ReposResponse>({ repos: repos.map(({ id, name, path }) => ({ id, name, path })) });
  });

  // Runs git on a path the builder typed. Acceptable only because localOnly
  // keeps everyone but this machine's own browser out.
  app.post('/api/repos', async (c) => {
    const { path } = await body(c, RepoBody);
    const clone = await registerLocalClone(db, await openRepo(path));
    return c.json<RepoView>({ id: clone.id, name: clone.name, path: clone.path }, 201);
  });

  app.get('/api/repos/:id/identities', async (c) => {
    const { repo } = await cloneOr404(id(c));
    const known = await loadIdentitySet(db, userId);
    return c.json<IdentitiesResponse>({ unresolved: unresolvedIdentities(await authorIdentities(repo), known) });
  });

  app.post('/api/identities', async (c) => {
    const { email, name, verdict } = await body(c, IdentityBody);
    await recordIdentity(db, userId, { email, name }, verdict);
    return c.json({ ok: true });
  });

  app.post('/api/repos/:id/refresh', async (c) => {
    const { clone, repo } = await cloneOr404(id(c));
    return c.json<RefreshResponse>(await refreshCandidates(db, repo, clone, userId));
  });

  app.get('/api/repos/:id/questions', async (c) => {
    const { clone } = await cloneOr404(id(c));
    const limit = Limit.parse(c.req.query('limit'));
    const budget = await weeklyBudget(db, userId, { limit });
    const next = await nextCandidates(db, userId, { limit, repoId: clone.id });
    return c.json<QuestionsResponse>({
      budget,
      questions: next.map((candidate, i) => ({
        candidateId: candidate.id,
        ...questionFor(candidate, budget.shownThisWeek + i + 1, budget.limit),
      })),
    });
  });

  // Showing spends the budget, so the page reports it when it renders a
  // question — not when it fetches the list.
  app.post('/api/candidates/:id/shown', async (c) => {
    const candidate = await loadCandidate(db, userId, id(c));
    if (candidate === null) throw new NotFound('No such question.');
    await markShown(db, candidate.id);
    return c.json({ ok: true });
  });

  app.post('/api/candidates/:id/answer', async (c) => {
    const candidate = await loadCandidate(db, userId, id(c));
    if (candidate === null) throw new NotFound('No such question.');
    const answer = await body(c, AnswerBody);
    const normalized =
      answer.kind === 'decision' ? { ...answer, shape: shapeOf(answer.shape) } : answer;

    // Only answers this question offered: no `made` on an agent's change (G4).
    if (!isOffered(questionFor(candidate, 1, 1), normalized)) {
      throw new BadRequest('That answer is not one of the options for this question.');
    }

    const { repo } = await cloneOr404(candidate.repoId);
    const result = await answerCandidate(db, {
      userId,
      repoId: candidate.repoId,
      candidate,
      answer: normalized,
      cost: candidateCostContext(candidate, await costContextFor(repo)),
    });
    return c.json<AnswerResponse>(result);
  });

  app.post('/api/decisions/:id/revise', async (c) => {
    const { shape } = await body(c, z.object({ shape: Shape }));
    const verdict = await reviseWithCheck(db, userId, id(c), shapeOf(shape), async (repoId) =>
      costContextFor((await cloneOr404(repoId)).repo),
    );
    if (verdict === null) throw new NotFound('No such decision.');
    return c.json<ReviseResponse>({ verdict });
  });

  app.post('/api/repos/:id/manual', async (c) => {
    const { clone, repo } = await cloneOr404(id(c));
    const { shape, anchor } = await body(c, ManualBody);
    const result = await recordManual(db, {
      userId,
      repoId: clone.id,
      shape: shapeOf(shape),
      anchor: {
        ...(anchor.sha === undefined ? {} : { sha: anchor.sha }),
        ...(anchor.path === undefined ? {} : { path: anchor.path }),
      },
      repo: await costContextFor(repo),
    });
    return c.json<ManualResponse>(result, 201);
  });

  app.get('/api/decisions', async (c) => {
    const records = await listDecisions(db, userId);
    return c.json<DecisionsResponse>({
      decisions: records.map((d) => ({
        id: d.id,
        role: d.role,
        origin: d.origin,
        repoName: d.repoName,
        anchorSha: d.anchorSha,
        anchorPath: d.anchorPath,
        context: d.context,
        optionsConsidered: d.optionsConsidered,
        choice: d.choice,
        cost: d.cost,
        revisitCondition: d.revisitCondition,
        costFeedback: d.costFeedback,
        missing: missingParts(d),
        createdAt: d.createdAt.toISOString(),
      })),
    });
  });

  app.get('/api/calibration', async (c) => c.json<CalibrationResponse>(await calibration(db, userId)));

  app.notFound((c) => c.json({ error: 'Not found.' }, 404));
  app.onError((error, c) => {
    if (error instanceof BadRequest || error instanceof GitError) return c.json({ error: error.message }, 400);
    if (error instanceof NotFound) return c.json({ error: error.message }, 404);
    if (error instanceof Error && /is not pending/.test(error.message)) {
      return c.json({ error: 'That question has already been answered.' }, 409);
    }
    console.error(error);
    return c.json({ error: 'Something went wrong on the server; see its terminal.' }, 500);
  });

  return app;
}
