/**
 * Setting learning goals for a project (0007 §2): new or existing. The ticked
 * outcomes are the project's objective; the full list is still the
 * percentage's denominator (coverage.ts).
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';

import { learningGoalOutcomeChanges, learningGoalOutcomes, learningGoals, questions, skillOutcomes } from '../../db/schema.js';
import { headSha } from '../git/index.js';
import { BUILTIN_SKILLS } from './catalog/index.js';
import { backfillSightings, goalOutcomes, snapshotScan, type ScanScope } from './scan.js';
import { outcomesOf, resolveSkill, syncCatalogue } from './sync.js';

export interface GoalRequest {
  /** Any skill: "SQL", "Docker", "Redis"… */
  name: string;
  /** Outcome slugs to tick, or every outcome. */
  objective: 'all' | readonly string[];
}

export interface GoalSet {
  goalId: string;
  skill: string;
  created: boolean;
  /** Set again after being stopped. */
  reopened: boolean;
  /** False for skills whose list is drafted by a model in 0009. */
  hasOutcomeList: boolean;
}

export interface SetGoalsResult {
  goals: GoalSet[];
  declaredAtSha: string;
  /** Commits newly sighted as "before the goal". */
  backfilled: number;
  /** Places the existing code already touches the new goals' outcomes. */
  alreadyTouched: number;
}

export async function setGoals(scope: ScanScope, requests: readonly GoalRequest[]): Promise<SetGoalsResult> {
  const { db, userId, repoId, repo } = scope;
  await syncCatalogue(db);
  const sha = await headSha(repo);
  const goals: GoalSet[] = [];

  for (const req of requests) {
    const skill = await resolveSkill(db, req.name);
    const [existing] = await db
      .select({ id: learningGoals.id, status: learningGoals.status })
      .from(learningGoals)
      .where(
        and(
          eq(learningGoals.userId, userId),
          eq(learningGoals.repoId, repoId),
          eq(learningGoals.skillId, skill.id),
          eq(learningGoals.kind, 'intent'),
        ),
      );

    let goalId = existing?.id;
    // Set again after being stopped: the same goal comes back, with its history
    // and its original "set at" commit, rather than a second one.
    if (existing !== undefined && existing.status === 'abandoned') {
      await db.update(learningGoals).set({ status: 'open', closedAt: null }).where(eq(learningGoals.id, existing.id));
    }
    if (goalId === undefined) {
      const [row] = await db
        .insert(learningGoals)
        .values({ userId, repoId, skillId: skill.id, kind: 'intent', title: skill.name, declaredAtSha: sha })
        .returning({ id: learningGoals.id });
      if (row === undefined) throw new Error(`could not set a goal for ${skill.name}`);
      goalId = row.id;
    }

    const outcomes = await outcomesOf(db, [skill.id]);
    for (const o of outcomes) {
      await setObjective(scope, goalId, o.id, req.objective === 'all' || req.objective.includes(o.slug));
    }
    goals.push({
      goalId,
      skill: skill.slug,
      created: existing === undefined,
      reopened: existing?.status === 'abandoned',
      hasOutcomeList: outcomes.length > 0,
    });
  }

  // Sight everything that exists before scanning it, so the next scan treats
  // only genuinely new commits as "after the goal".
  const backfilled = await backfillSightings(db, repo, repoId);

  // A reopened goal is read afresh too: commits that arrived while it was stopped were not scanned for it.
  const fresh = new Set(goals.filter((g) => g.created || g.reopened).map((g) => g.skill));
  const all = await goalOutcomes(db, userId, repoId);
  const freshSlugs = new Set(
    BUILTIN_SKILLS.filter((s) => fresh.has(s.slug)).flatMap((s) => s.outcomes.map((o) => o.slug)),
  );
  const alreadyTouched = await snapshotScan(scope, {
    defs: all.defs.filter((d) => freshSlugs.has(d.slug)),
    idBySlug: all.idBySlug,
  });

  return { goals, declaredAtSha: sha, backfilled, alreadyTouched };
}

/** Tick or untick one outcome. Every change is kept (0007 §2). */
export async function setObjective(
  scope: Pick<ScanScope, 'db'>,
  goalId: string,
  outcomeId: string,
  inObjective: boolean,
): Promise<void> {
  const { db } = scope;
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ inObjective: learningGoalOutcomes.inObjective })
      .from(learningGoalOutcomes)
      .where(and(eq(learningGoalOutcomes.goalId, goalId), eq(learningGoalOutcomes.outcomeId, outcomeId)));
    if (current?.inObjective === inObjective) return;

    await tx
      .insert(learningGoalOutcomes)
      .values({ goalId, outcomeId, inObjective })
      .onConflictDoUpdate({
        target: [learningGoalOutcomes.goalId, learningGoalOutcomes.outcomeId],
        set: { inObjective, updatedAt: new Date() },
      });
    await tx.insert(learningGoalOutcomeChanges).values({ goalId, outcomeId, inObjective });
  });
}

/** The project's goals, for listing. */
export async function goalsFor(scope: Pick<ScanScope, 'db' | 'userId' | 'repoId'>) {
  return scope.db
    .select()
    .from(learningGoals)
    .where(
      and(
        eq(learningGoals.userId, scope.userId),
        eq(learningGoals.repoId, scope.repoId),
        inArray(learningGoals.kind, ['intent']),
        ne(learningGoals.status, 'abandoned'),
      ),
    )
    .orderBy(learningGoals.openedAt);
}

/**
 * Stop tracking a goal in a project. Nothing is deleted: its objective history
 * and sightings stay, and setting the same skill again brings it back. Its
 * open questions are retired, since they would ask about a goal you dropped.
 */
export async function stopGoal(scope: Pick<ScanScope, 'db' | 'userId' | 'repoId'>, goalId: string): Promise<boolean> {
  const { db, userId, repoId } = scope;
  return db.transaction(async (tx) => {
    const [goal] = await tx
      .update(learningGoals)
      .set({ status: 'abandoned', closedAt: new Date() })
      .where(and(eq(learningGoals.id, goalId), eq(learningGoals.userId, userId), eq(learningGoals.repoId, repoId), eq(learningGoals.kind, 'intent')))
      .returning({ skillId: learningGoals.skillId });
    if (goal === undefined) return false;
    if (goal.skillId !== null) {
      const outcomeIds = (await tx.select({ id: skillOutcomes.id }).from(skillOutcomes).where(eq(skillOutcomes.skillId, goal.skillId))).map((o) => o.id);
      if (outcomeIds.length > 0) {
        await tx
          .update(questions)
          .set({ status: 'expired' })
          .where(and(eq(questions.repoId, repoId), eq(questions.status, 'pending'), inArray(questions.outcomeId, outcomeIds), isNull(questions.answeredAt)));
      }
    }
    return true;
  });
}
