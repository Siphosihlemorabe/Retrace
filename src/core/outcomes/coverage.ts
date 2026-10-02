/**
 * Coverage (0007 §5): per goal, what each outcome's status is, the percentage
 * learned and the objective.
 *
 * - **Percentage** = learned ÷ the skill's *full* outcome list, so unticking
 *   hard outcomes can never raise it (product-direction §3.7).
 * - **Objective** = ticked outcomes learned ÷ ticked outcomes.
 * - **Learned** needs documenting (0010) and a passed check (0011); until those
 *   exist it is always 0%. Touched code is shown, never counted.
 *
 * There is no number for the person, only for a goal in a project (G2).
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';

import {
  learningGoalOutcomes,
  learningGoals,
  outcomeSightings,
  skillOutcomes,
  skills,
} from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import type { Authorship } from '../detect/authorship.js';

export type OutcomeStatus = 'not_touched' | 'touched' | 'documented' | 'learned';

export interface SightingView {
  sha: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  via: string;
  foundBy: string;
  authorship: Authorship;
  /** `before` = already in the project when the goal was set. */
  when: 'before_goal' | 'after_goal';
}

export interface OutcomeCoverage {
  slug: string;
  name: string;
  description: string;
  inObjective: boolean;
  status: OutcomeStatus;
  /** Best first: the builder's own, after the goal, then the rest. */
  sightings: SightingView[];
}

export interface GoalCoverage {
  goalId: string;
  skill: { slug: string; name: string };
  declaredAtSha: string | null;
  declaredAt: Date;
  /** False for skills whose list is drafted by a model (0009); nothing to show yet. */
  hasOutcomeList: boolean;
  /** The list was drafted by a model and reviewed by the builder: its coverage is found by the model too. */
  modelList: boolean;
  total: number;
  learned: number;
  /** Whole percent of the full list, or null when there is no list. */
  percentLearned: number | null;
  touched: number;
  objective: { met: number; total: number };
  outcomes: OutcomeCoverage[];
}

const AUTHOR_RANK: Record<Authorship, number> = {
  builder: 0,
  builder_with_agent: 1,
  agent: 2,
  other_human: 3,
  unknown: 4,
  template: 5,
  automation: 6,
};

export function rankSightings(sightings: readonly SightingView[]): SightingView[] {
  return [...sightings].sort(
    (a, b) =>
      (a.when === 'after_goal' ? 0 : 1) - (b.when === 'after_goal' ? 0 : 1) ||
      AUTHOR_RANK[a.authorship] - AUTHOR_RANK[b.authorship],
  );
}

/** Pure: everything a goal's coverage is computed from. */
export function computeCoverage(input: {
  goalId: string;
  skill: { slug: string; name: string };
  declaredAtSha: string | null;
  declaredAt: Date;
  outcomes: readonly { slug: string; name: string; description: string; inObjective: boolean }[];
  sightings: ReadonlyMap<string, readonly SightingView[]>;
  documented: ReadonlySet<string>;
  learned: ReadonlySet<string>;
  modelList?: boolean;
}): GoalCoverage {
  const outcomes: OutcomeCoverage[] = input.outcomes.map((o) => {
    const sightings = rankSightings(input.sightings.get(o.slug) ?? []);
    const status: OutcomeStatus = input.learned.has(o.slug)
      ? 'learned'
      : input.documented.has(o.slug)
        ? 'documented'
        : sightings.length > 0
          ? 'touched'
          : 'not_touched';
    return { ...o, status, sightings };
  });

  const total = outcomes.length;
  const learned = outcomes.filter((o) => o.status === 'learned').length;
  const ticked = outcomes.filter((o) => o.inObjective);
  return {
    goalId: input.goalId,
    skill: input.skill,
    declaredAtSha: input.declaredAtSha,
    declaredAt: input.declaredAt,
    hasOutcomeList: total > 0,
    modelList: input.modelList ?? false,
    total,
    learned,
    percentLearned: total === 0 ? null : Math.round((learned / total) * 100),
    touched: outcomes.filter((o) => o.status !== 'not_touched').length,
    objective: { met: ticked.filter((o) => o.status === 'learned').length, total: ticked.length },
    outcomes,
  };
}

/** Coverage for every goal in a project, from the database. */
export async function loadCoverage(db: Db, userId: string, repoId: string): Promise<GoalCoverage[]> {
  const goals = await db
    .select({
      id: learningGoals.id,
      skillId: learningGoals.skillId,
      skillSlug: skills.slug,
      skillName: skills.name,
      declaredAtSha: learningGoals.declaredAtSha,
      declaredAt: learningGoals.openedAt,
    })
    .from(learningGoals)
    .innerJoin(skills, eq(skills.id, learningGoals.skillId))
    .where(and(eq(learningGoals.userId, userId), eq(learningGoals.repoId, repoId), eq(learningGoals.kind, 'intent'), ne(learningGoals.status, 'abandoned')))
    .orderBy(learningGoals.openedAt);
  if (goals.length === 0) return [];

  const outcomeRows = await db
    .select({
      goalId: learningGoalOutcomes.goalId,
      id: skillOutcomes.id,
      slug: skillOutcomes.slug,
      name: skillOutcomes.name,
      description: skillOutcomes.description,
      ordinal: skillOutcomes.ordinal,
      inObjective: learningGoalOutcomes.inObjective,
      source: skillOutcomes.source,
    })
    .from(learningGoalOutcomes)
    .innerJoin(skillOutcomes, eq(skillOutcomes.id, learningGoalOutcomes.outcomeId))
    // A retired outcome is no longer on the list, so it is not in the denominator either.
    .where(and(inArray(learningGoalOutcomes.goalId, goals.map((g) => g.id)), isNull(skillOutcomes.retiredAt)))
    .orderBy(skillOutcomes.ordinal);

  const sightingRows = await db
    .select({
      outcomeId: outcomeSightings.outcomeId,
      sha: outcomeSightings.sha,
      path: outcomeSightings.path,
      lineStart: outcomeSightings.lineStart,
      lineEnd: outcomeSightings.lineEnd,
      via: outcomeSightings.via,
      foundBy: outcomeSightings.foundBy,
      authorship: outcomeSightings.authorship,
      scanKind: outcomeSightings.scanKind,
      writtenAfterGoal: outcomeSightings.writtenAfterGoal,
    })
    .from(outcomeSightings)
    .where(eq(outcomeSightings.repoId, repoId));

  const slugById = new Map(outcomeRows.map((o) => [o.id, o.slug]));
  const sightings = new Map<string, SightingView[]>();
  for (const s of sightingRows) {
    const slug = slugById.get(s.outcomeId);
    if (slug === undefined) continue;
    const list = sightings.get(slug) ?? [];
    list.push({
      sha: s.sha,
      path: s.path,
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
      via: s.via,
      foundBy: s.foundBy,
      authorship: s.authorship as Authorship,
      // Model sightings read the current code and know from blame; rule sightings go by scan kind.
      when: (s.writtenAfterGoal ?? s.scanKind === 'commit') ? 'after_goal' : 'before_goal',
    });
    sightings.set(slug, list);
  }

  return goals.map((g) =>
    computeCoverage({
      goalId: g.id,
      skill: { slug: g.skillSlug, name: g.skillName },
      declaredAtSha: g.declaredAtSha,
      declaredAt: g.declaredAt,
      outcomes: outcomeRows.filter((o) => o.goalId === g.id),
      modelList: outcomeRows.some((o) => o.goalId === g.id && o.source !== 'builtin'),
      sightings,
      // Documenting (0010) and checks (0011) are not built: nothing is
      // documented or learned yet, and the percentage says so honestly.
      documented: new Set(),
      learned: new Set(),
    }),
  );
}
