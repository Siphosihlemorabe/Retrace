/**
 * Setting learning goals for a project (0007 §2): new or existing. The ticked
 * outcomes are the project's objective; the full list is still the
 * percentage's denominator (coverage.ts).
 */
import { and, eq, inArray } from 'drizzle-orm';

import { learningGoalOutcomeChanges, learningGoalOutcomes, learningGoals } from '../../db/schema.js';
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
      .select({ id: learningGoals.id })
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
    goals.push({ goalId, skill: skill.slug, created: existing === undefined, hasOutcomeList: outcomes.length > 0 });
  }

  // Sight everything that exists before scanning it, so the next scan treats
  // only genuinely new commits as "after the goal".
  const backfilled = await backfillSightings(db, repo, repoId);

  const fresh = new Set(goals.filter((g) => g.created).map((g) => g.skill));
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
      ),
    )
    .orderBy(learningGoals.openedAt);
}
