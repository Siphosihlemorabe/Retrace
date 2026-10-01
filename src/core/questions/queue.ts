/**
 * Which questions to ask this week, in the builder's order (0009 §2):
 *
 *   1. linked to this project's objective — code you wrote first, then code
 *      your agent wrote, then objective outcomes nothing touches yet
 *   2. important — the dependency decisions other code depends on (0001–0003)
 *   3. the rest — touched outcomes outside the objective
 *
 * At most the builder's weekly number (minimum 3) are shown per rolling seven
 * days, shared with the dependency questions (G6). One question per outcome
 * per project for now; re-asking later is 0009's open question 2.
 */
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';

import {
  candidates,
  learningGoalOutcomes,
  learningGoals,
  outcomeSightings,
  practiceAnswers,
  questions,
  repos,
  skillOutcomes,
  skills,
  userSettings,
} from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import { ASKABLE } from '../decisions/budget.js';
import { fromCandidateRow } from '../detect/candidate-row.js';
import type { Authorship } from '../detect/authorship.js';
import { DETECTOR_VERSION } from '../detect/rank.js';
import { providerFromEnv, type Provider } from '../llm/index.js';
import type { Repo } from '../git/index.js';
import { generate, type Target } from './generate.js';
import { QUESTION_PROMPT_VERSION } from './prompt.js';

export const MIN_PER_WEEK = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// --- Settings ------------------------------------------------------------------

export async function questionsPerWeek(db: Db, userId: string): Promise<number> {
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return row?.questionsPerWeek ?? MIN_PER_WEEK;
}

export async function setQuestionsPerWeek(db: Db, userId: string, n: number): Promise<number> {
  if (!Number.isInteger(n) || n < MIN_PER_WEEK) throw new Error(`At least ${MIN_PER_WEEK} questions a week.`);
  await db
    .insert(userSettings)
    .values({ userId, questionsPerWeek: n })
    .onConflictDoUpdate({ target: userSettings.userId, set: { questionsPerWeek: n, updatedAt: new Date() } });
  return n;
}

/** Shown in the last seven days, across outcome and dependency questions. */
export async function questionBudget(db: Db, userId: string, now = new Date()) {
  const since = new Date(now.getTime() - WEEK_MS);
  const limit = await questionsPerWeek(db, userId);
  const [[outcome], [dependency]] = await Promise.all([
    db
      .select({ n: count() })
      .from(questions)
      .where(and(eq(questions.userId, userId), ne(questions.targetKind, 'candidate'), gte(questions.shownAt, since))),
    // A dependency question spends the budget through its candidate's asked_at,
    // as 0002's flow always has, so it is counted there and only there.
    db.select({ n: count() }).from(candidates).where(and(eq(candidates.userId, userId), gte(candidates.askedAt, since))),
  ]);
  const shownThisWeek = (outcome?.n ?? 0) + (dependency?.n ?? 0);
  return { limit, shownThisWeek, remaining: Math.max(0, limit - shownThisWeek) };
}

// --- Targets, in order -------------------------------------------------------------

const YOURS: readonly Authorship[] = ['builder', 'builder_with_agent'];

async function targets(db: Db, userId: string, repoId: string, want: number): Promise<Target[]> {
  if (want <= 0) return [];

  const asked = await db
    .select({ sightingId: questions.sightingId, outcomeId: questions.outcomeId, candidateId: questions.candidateId })
    .from(questions)
    .where(and(eq(questions.userId, userId), eq(questions.repoId, repoId)));
  const askedSightings = new Set(asked.flatMap((a) => (a.sightingId === null ? [] : [a.sightingId])));
  const askedCandidates = new Set(asked.flatMap((a) => (a.candidateId === null ? [] : [a.candidateId])));
  const askedOutcomes = new Set(asked.flatMap((a) => (a.outcomeId === null ? [] : [a.outcomeId])));

  const goalOutcomes = await db
    .select({
      outcomeId: skillOutcomes.id,
      name: skillOutcomes.name,
      description: skillOutcomes.description,
      skill: skills.name,
      inObjective: learningGoalOutcomes.inObjective,
    })
    .from(learningGoalOutcomes)
    .innerJoin(learningGoals, eq(learningGoals.id, learningGoalOutcomes.goalId))
    .innerJoin(skillOutcomes, eq(skillOutcomes.id, learningGoalOutcomes.outcomeId))
    .innerJoin(skills, eq(skills.id, skillOutcomes.skillId))
    .where(and(eq(learningGoals.userId, userId), eq(learningGoals.repoId, repoId), eq(learningGoals.kind, 'intent'), isNull(skillOutcomes.retiredAt)));
  const byOutcome = new Map(goalOutcomes.map((o) => [o.outcomeId, o]));

  const sightings = goalOutcomes.length === 0 ? [] : await db
    .select()
    .from(outcomeSightings)
    .where(and(eq(outcomeSightings.repoId, repoId), inArray(outcomeSightings.outcomeId, goalOutcomes.map((o) => o.outcomeId))));
  // Questions already asked about a sighting mark its outcome as asked too.
  for (const s of sightings) if (askedSightings.has(s.id)) askedOutcomes.add(s.outcomeId);

  const out: Target[] = [];
  const used = new Set<string>(askedOutcomes);
  const afterFirst = (a: typeof sightings[number]) => (a.writtenAfterGoal ?? a.scanKind === 'commit' ? 0 : 1);
  const sightingTarget = (s: typeof sightings[number]): Target => {
    const o = byOutcome.get(s.outcomeId)!;
    return {
      kind: 'outcome_sighting',
      sightingId: s.id,
      outcomeId: s.outcomeId,
      outcome: { name: o.name, description: o.description, skill: o.skill },
      sha: s.sha,
      path: s.path,
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
      authorship: s.authorship as Authorship,
      inObjective: o.inObjective,
    };
  };
  const take = (list: typeof sightings) => {
    for (const s of [...list].sort((a, b) => afterFirst(a) - afterFirst(b))) {
      if (out.length >= want) return;
      if (used.has(s.outcomeId) || askedSightings.has(s.id)) continue;
      used.add(s.outcomeId);
      out.push(sightingTarget(s));
    }
  };
  const inObjective = (s: typeof sightings[number]) => byOutcome.get(s.outcomeId)?.inObjective === true;

  // 1a. Objective, code you wrote.
  take(sightings.filter((s) => inObjective(s) && YOURS.includes(s.authorship as Authorship)));
  // 1b. Objective, code your agent (or anyone else) wrote.
  take(sightings.filter((s) => inObjective(s)));
  // 1c. Objective outcomes nothing touches yet.
  const touched = new Set(sightings.map((s) => s.outcomeId));
  for (const o of goalOutcomes) {
    if (out.length >= want) break;
    if (!o.inObjective || touched.has(o.outcomeId) || used.has(o.outcomeId)) continue;
    used.add(o.outcomeId);
    out.push({ kind: 'outcome_untouched', outcomeId: o.outcomeId, outcome: { name: o.name, description: o.description, skill: o.skill } });
  }

  // 2. Important: dependency decisions, best-ranked first.
  if (out.length < want) {
    const rows = await db
      .select()
      .from(candidates)
      .where(
        and(
          eq(candidates.userId, userId),
          eq(candidates.repoId, repoId),
          eq(candidates.status, 'pending'),
          eq(candidates.detectorVersion, DETECTOR_VERSION),
          inArray(candidates.introducedBy, [...ASKABLE]),
        ),
      )
      .orderBy(desc(candidates.rankScore))
      .limit(want * 2);
    for (const row of rows) {
      if (out.length >= want) break;
      if (askedCandidates.has(row.id)) continue;
      out.push({ kind: 'candidate', candidate: fromCandidateRow(row) });
    }
  }

  // 3. The rest: touched outcomes outside the objective.
  take(sightings);
  return out;
}

// --- The week's questions ------------------------------------------------------------

export type StoredQuestion = typeof questions.$inferSelect;

/**
 * This week's questions for a project: any already shown and not yet answered,
 * then new ones up to what's left of the budget — generated now, by the model
 * when it may.
 */
export async function nextQuestions(
  scope: { db: Db; userId: string; repo: Repo; repoId: string },
  provider: Provider | null = providerFromEnv(),
): Promise<StoredQuestion[]> {
  const { db, userId, repoId } = scope;
  const open = await db
    .select()
    .from(questions)
    .where(and(eq(questions.userId, userId), eq(questions.repoId, repoId), eq(questions.status, 'pending')))
    .orderBy(questions.createdAt);
  // Candidate questions whose candidate was answered elsewhere (the CLI) are done.
  const stillOpen: StoredQuestion[] = [];
  for (const q of open) {
    if (q.candidateId !== null) {
      const [c] = await db.select({ status: candidates.status }).from(candidates).where(eq(candidates.id, q.candidateId));
      if (c?.status !== 'pending') {
        await db.update(questions).set({ status: 'answered', answeredAt: new Date() }).where(eq(questions.id, q.id));
        continue;
      }
    }
    stillOpen.push(q);
  }

  const unshown = stillOpen.filter((q) => q.shownAt === null).length;
  const { remaining } = await questionBudget(db, userId);
  const want = remaining - unshown;

  const [repoRow] = await db.select({ llmAllowedAt: repos.llmAllowedAt }).from(repos).where(eq(repos.id, repoId));
  const genScope = { ...scope, llmAllowed: repoRow?.llmAllowedAt != null };

  const fresh: StoredQuestion[] = [];
  for (const target of await targets(db, userId, repoId, want)) {
    const g = await generate(genScope, target, provider);
    const [row] = await db
      .insert(questions)
      .values({
        userId,
        repoId,
        targetKind: target.kind,
        sightingId: target.kind === 'outcome_sighting' ? target.sightingId : null,
        outcomeId: target.kind === 'candidate' ? null : target.outcomeId,
        candidateId: target.kind === 'candidate' ? target.candidate.id : null,
        text: g.text,
        sha: target.kind === 'outcome_sighting' ? target.sha : null,
        path: target.kind === 'outcome_sighting' ? target.path : null,
        lineStart: g.lines?.[0] ?? null,
        lineEnd: g.lines?.[1] ?? null,
        keyPoints: g.keyPoints,
        foundBy: g.foundBy,
        promptVersion: QUESTION_PROMPT_VERSION,
        provider: g.provider,
        model: g.model,
        cacheKey: g.cacheKey,
      })
      .onConflictDoNothing()
      .returning();
    if (row !== undefined) fresh.push(row);
  }
  // Shown-but-unanswered first (they cost nothing more), then the new ones.
  return [...stillOpen.filter((q) => q.shownAt !== null), ...stillOpen.filter((q) => q.shownAt === null), ...fresh];
}

/** On screen: this is what spends the budget. A dependency question also marks its candidate, as 0002 does. */
export async function markQuestionShown(db: Db, userId: string, questionId: string): Promise<void> {
  const [q] = await db
    .update(questions)
    .set({ shownAt: sql`COALESCE(${questions.shownAt}, now())` })
    .where(and(eq(questions.id, questionId), eq(questions.userId, userId)))
    .returning();
  if (q?.candidateId != null) {
    await db.update(candidates).set({ askedAt: new Date() }).where(and(eq(candidates.id, q.candidateId), isNull(candidates.askedAt)));
  }
}

/** A practice answer (G3): stored, never counted. */
export async function answerQuestion(db: Db, userId: string, questionId: string, answer: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [q] = await tx
      .update(questions)
      .set({ status: 'answered', answeredAt: new Date() })
      .where(and(eq(questions.id, questionId), eq(questions.userId, userId), eq(questions.status, 'pending'), ne(questions.targetKind, 'candidate')))
      .returning({ id: questions.id });
    if (q === undefined) throw new Error('That question is not open for a written answer.');
    await tx.insert(practiceAnswers).values({ userId, questionId, answer });
  });
}

/** A dependency question answered through 0002's flow closes its question too. */
export async function closeCandidateQuestion(db: Db, userId: string, candidateId: string): Promise<void> {
  await db
    .update(questions)
    .set({ status: 'answered', answeredAt: new Date() })
    .where(and(eq(questions.userId, userId), eq(questions.candidateId, candidateId), eq(questions.status, 'pending')));
}

/** Back to the pool; the third skip retires it. */
export async function skipQuestion(db: Db, userId: string, questionId: string): Promise<'pending' | 'expired'> {
  const [q] = await db
    .update(questions)
    .set({
      skipCount: sql`${questions.skipCount} + 1`,
      status: sql`CASE WHEN ${questions.skipCount} + 1 >= 3 THEN 'expired' ELSE 'pending' END`,
      shownAt: null,
    })
    .where(and(eq(questions.id, questionId), eq(questions.userId, userId), eq(questions.status, 'pending')))
    .returning({ status: questions.status });
  if (q === undefined) throw new Error('That question is not open.');
  return q.status as 'pending' | 'expired';
}

/** Consent, once per repo, before code goes to a model off this machine. */
export async function allowModelForRepo(db: Db, repoId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(repos).set({ llmAllowedAt: new Date() }).where(and(eq(repos.id, repoId), isNull(repos.llmAllowedAt)));
    // Questions written without the model and never shown have no answers and
    // no reader yet: drop them, so the next ones are written by the model.
    await tx
      .delete(questions)
      .where(and(eq(questions.repoId, repoId), eq(questions.foundBy, 'rule'), eq(questions.status, 'pending'), isNull(questions.shownAt)));
  });
}

export async function modelAllowed(db: Db, repoId: string): Promise<boolean> {
  const [r] = await db.select({ at: repos.llmAllowedAt }).from(repos).where(and(eq(repos.id, repoId), isNotNull(repos.llmAllowedAt)));
  return r !== undefined;
}
