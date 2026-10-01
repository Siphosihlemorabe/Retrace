/**
 * The local API (0006): the capture loop over JSON, for the web UI.
 *
 * Routes are thin — parse, check, delegate to core/decisions — so the browser
 * and the terminal run the same code. Request bodies are untrusted and parsed
 * with Zod at the boundary (G16); nothing past this file sees raw input.
 */
import { eq } from 'drizzle-orm';
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
import { authorIdentities, commitPositions, GitError, openRepo } from '../core/git/index.js';
import { createGithubRepo, createProjectFolder, githubCliReady } from '../core/git/new-project.js';
import { BUILTIN_SKILLS } from '../core/outcomes/catalog/index.js';
import { codeView } from '../core/outcomes/code-view.js';
import { loadCoverage } from '../core/outcomes/coverage.js';
import { setGoals } from '../core/outcomes/goals.js';
import { relabelLines, scanNewCommits } from '../core/outcomes/scan.js';
import { draftOutcomes, DraftOutcome, saveOutcomeList } from '../core/outcomes/draft.js';
import { modelScan } from '../core/outcomes/model-scan.js';
import { llmStatus, providerFromEnv, type Provider } from '../core/llm/index.js';
import {
  allowModelForRepo,
  answerQuestion,
  closeCandidateQuestion,
  markQuestionShown,
  modelAllowed,
  nextQuestions,
  questionBudget,
  questionsPerWeek,
  setQuestionsPerWeek,
  skipQuestion,
  MIN_PER_WEEK,
} from '../core/questions/queue.js';
import { questionCard } from '../core/questions/view.js';
import { questions as questionsTable, skills } from '../db/schema.js';
import type { Db } from '../db/types.js';
import type {
  AnswerResponse,
  CalibrationResponse,
  CodeViewResponse,
  CoverageResponse,
  DraftOutcomesResponse,
  LlmStatusResponse,
  ModelScanResponse,
  SavedOutcomesResponse,
  SkipResponse,
  WeekResponse,
  GithubReadyResponse,
  LabelResponse,
  ScanResponse,
  SetGoalsResponse,
  SkillsResponse,
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
const ProjectBody = z.object({
  path: z.string().trim().min(1).max(1000),
  github: z.enum(['private', 'public']).optional(),
});
const GoalsBody = z.object({
  goals: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        objective: z.union([z.literal('all'), z.array(z.string().max(100)).max(200)]),
      }),
    )
    .min(1)
    .max(20),
});
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const CodeQuery = z.object({ sha: Sha, path: z.string().min(1).max(1000) });
const LabelBody = z.object({
  sha: Sha,
  path: z.string().min(1).max(1000),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
  label: z.enum(['agent', 'me']),
});
const Id = z.uuid();
const SettingsBody = z.object({ questionsPerWeek: z.number().int().min(MIN_PER_WEEK).max(50) });
const PracticeBody = z.object({ answer: z.string().trim().min(1).max(5000) });
const OutcomeListBody = z.object({
  outcomes: z.array(DraftOutcome.extend({ slug: z.string().max(200).optional() })).min(1).max(20),
});
const ScanBody = z.object({ skill: z.string().min(1).max(200) });
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
    await closeCandidateQuestion(db, userId, candidate.id);
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

  // --- 0007: goals, coverage, code view --------------------------------------

  const scopeFor = async (repoId: string) => {
    const { clone, repo } = await cloneOr404(repoId);
    return { clone, repo, scope: { db, userId, repo, repoId: clone.id } };
  };

  app.get('/api/skills', (c) =>
    c.json<SkillsResponse>({
      skills: BUILTIN_SKILLS.map((s) => ({
        slug: s.slug,
        name: s.name,
        outcomes: s.outcomes.map((o) => ({ slug: o.slug, name: o.name, description: o.description })),
      })),
    }),
  );

  app.get('/api/github-ready', async (c) => c.json<GithubReadyResponse>({ ready: await githubCliReady() }));

  // Creating a folder runs git on a path the builder typed; creating a GitHub
  // repo changes their account. The second only happens when the request names
  // a visibility, which the page sends only after an explicit confirmation.
  app.post('/api/projects', async (c) => {
    const { path, github } = await body(c, ProjectBody);
    const repo = await createProjectFolder(path);
    if (github !== undefined) await createGithubRepo(repo, github);
    const clone = await registerLocalClone(db, repo);
    return c.json<RepoView>({ id: clone.id, name: clone.name, path: clone.path }, 201);
  });

  app.post('/api/repos/:id/goals', async (c) => {
    const { scope } = await scopeFor(id(c));
    const { goals } = await body(c, GoalsBody);
    const result = await setGoals(scope, goals);
    return c.json<SetGoalsResponse>(result, 201);
  });

  app.post('/api/repos/:id/scan', async (c) => {
    const { scope } = await scopeFor(id(c));
    return c.json<ScanResponse>(await scanNewCommits(scope));
  });

  app.get('/api/repos/:id/coverage', async (c) => {
    const { repo, clone } = await scopeFor(id(c));
    const [goals, positions] = await Promise.all([loadCoverage(db, userId, clone.id), commitPositions(repo)]);
    const mentioned = new Set(goals.flatMap((g) => g.outcomes.flatMap((o) => o.sightings.map((s) => s.sha))));
    return c.json<CoverageResponse>({
      positions: Object.fromEntries([...mentioned].map((sha) => [sha, positions.indexOf.get(sha) ?? 0])),
      commitCount: positions.total,
      goals: goals.map((g) => ({ ...g, declaredAt: g.declaredAt.toISOString() })),
    });
  });

  app.get('/api/repos/:id/code', async (c) => {
    const { repo, scope } = await scopeFor(id(c));
    const query = CodeQuery.safeParse({ sha: c.req.query('sha'), path: c.req.query('path') });
    if (!query.success) throw new BadRequest(z.prettifyError(query.error));
    const view = await codeView(scope, query.data.sha, query.data.path);
    if (view === null) throw new NotFound('That file is not in that commit.');
    const positions = await commitPositions(repo);
    return c.json<CodeViewResponse>({
      sha: query.data.sha,
      path: query.data.path,
      position: positions.indexOf.get(query.data.sha) ?? null,
      ...view,
    });
  });

  app.post('/api/repos/:id/labels', async (c) => {
    const { scope } = await scopeFor(id(c));
    const label = await body(c, LabelBody);
    if (label.lineEnd < label.lineStart) throw new BadRequest('lineEnd must not be before lineStart.');
    return c.json<LabelResponse>({ updated: await relabelLines(scope, label) });
  });

  // --- 0009: model questions, settings, outcome lists ---------------------------

  /** The configured provider, or null when it is off or misconfigured (the status route says which). */
  const provider = (): Provider | null => {
    try {
      return providerFromEnv();
    } catch {
      return null;
    }
  };
  const ownQuestion = async (questionId: string) => {
    const [q] = await db.select().from(questionsTable).where(eq(questionsTable.id, questionId));
    if (q === undefined || q.userId !== userId) throw new NotFound('No such question.');
    return q;
  };
  const skillBySlug = async (slug: string) => {
    const [skill] = await db.select().from(skills).where(eq(skills.slug, slug));
    if (skill === undefined) throw new NotFound('No such skill.');
    return skill;
  };

  app.get('/api/llm', async (c) => {
    const status = await llmStatus(db, userId);
    return c.json<LlmStatusResponse>({ ...status, questionsPerWeek: await questionsPerWeek(db, userId) } as LlmStatusResponse);
  });

  app.put('/api/settings', async (c) => {
    const { questionsPerWeek: n } = await body(c, SettingsBody);
    return c.json({ questionsPerWeek: await setQuestionsPerWeek(db, userId, n) });
  });

  // The builder's yes, once per project, before its code goes to a model off this machine.
  app.post('/api/repos/:id/llm-consent', async (c) => {
    const { clone } = await cloneOr404(id(c));
    await allowModelForRepo(db, clone.id);
    return c.json({ ok: true });
  });

  app.get('/api/repos/:id/week', async (c) => {
    const { clone, repo } = await cloneOr404(id(c));
    const p = provider();
    const list = await nextQuestions({ db, userId, repo, repoId: clone.id }, p);
    const status = await llmStatus(db, userId);
    return c.json<WeekResponse>({
      budget: await questionBudget(db, userId),
      modelAllowed: !status.sendsCodeOffMachine || (await modelAllowed(db, clone.id)),
      llm: status as WeekResponse['llm'],
      questions: await Promise.all(list.map((q) => questionCard(db, repo, q))),
    });
  });

  app.post('/api/questions/:id/shown', async (c) => {
    const q = await ownQuestion(id(c));
    await markQuestionShown(db, userId, q.id);
    return c.json({ ok: true });
  });

  app.post('/api/questions/:id/answer', async (c) => {
    const q = await ownQuestion(id(c));
    const { answer } = await body(c, PracticeBody);
    await answerQuestion(db, userId, q.id, answer);
    return c.json({ ok: true });
  });

  app.post('/api/questions/:id/skip', async (c) => {
    const q = await ownQuestion(id(c));
    return c.json<SkipResponse>({ status: await skipQuestion(db, userId, q.id) });
  });

  // Only the skill's name goes to the model; nothing is saved until the builder saves a list.
  app.post('/api/skills/:slug/draft', async (c) => {
    const skill = await skillBySlug(c.req.param('slug'));
    const draft = await draftOutcomes(db, userId, skill.name, provider());
    return c.json<DraftOutcomesResponse>(
      draft.ok
        ? { outcomes: draft.value.outcomes, reason: null, message: null }
        : { outcomes: null, reason: draft.reason, message: draft.message },
    );
  });

  app.put('/api/skills/:slug/outcomes', async (c) => {
    const skill = await skillBySlug(c.req.param('slug'));
    const { outcomes } = await body(c, OutcomeListBody);
    try {
      return c.json<SavedOutcomesResponse>(await saveOutcomeList(db, skill.id, outcomes));
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  });

  app.post('/api/repos/:id/model-scan', async (c) => {
    const { clone, repo } = await cloneOr404(id(c));
    const { skill: slug } = await body(c, ScanBody);
    const skill = await skillBySlug(slug);
    const llmAllowed = await modelAllowed(db, clone.id);
    return c.json<ModelScanResponse>(await modelScan({ db, userId, repo, repoId: clone.id, llmAllowed }, skill.id, provider()));
  });

  app.notFound((c) => c.json({ error: 'Not found.' }, 404));
  app.onError((error, c) => {
    if (error instanceof BadRequest || error instanceof GitError) return c.json({ error: error.message }, 400);
    if (error instanceof NotFound) return c.json({ error: error.message }, 404);
    if (error instanceof Error && /is not open/.test(error.message)) {
      return c.json({ error: 'That question is no longer open.' }, 409);
    }
    if (error instanceof Error && /is not pending/.test(error.message)) {
      return c.json({ error: 'That question has already been answered.' }, 409);
    }
    console.error(error);
    return c.json({ error: 'Something went wrong on the server; see its terminal.' }, 500);
  });

  return app;
}
