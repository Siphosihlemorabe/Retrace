/**
 * Recording answers (0002 §3, 0003 §4). Every answer is one transaction: the
 * decision or goal, the candidate's new status, and any authorship dispute
 * land together or not at all.
 */
import { and, eq, max, sql } from 'drizzle-orm';

import {
  candidates,
  decisionRevisions,
  decisions,
  learningGoals,
} from '../../db/schema.js';
import type { Db, Tx } from '../../db/types.js';
import type { StoredCandidate } from '../detect/candidate-row.js';
import type { CostVerdict } from './cost-check.js';

/** The decision shape from CLAUDE.md. All optional: scaffolding, not a form. */
export interface DecisionShape {
  context: string | null;
  optionsConsidered: string | null;
  choice: string | null;
  cost: string | null;
  revisitCondition: string | null;
}

/** made it · directed an agent to make it · kept an agent's choice (0003). */
export type DecisionRole = 'made' | 'directed' | 'kept';

export type DismissalReason = 'not_my_choice' | 'not_a_choice' | 'not_load_bearing' | 'other';

const verdictColumns = (verdict: CostVerdict | null, now: Date) =>
  verdict === null
    ? {}
    : {
        costNamesLoss: verdict.namesLoss,
        costIsSystemSpecific: verdict.systemSpecific,
        costCheckVersion: verdict.version,
        costCheckedAt: now,
        costFeedback: verdict.feedback.length > 0 ? verdict.feedback.join('\n') : null,
      };

/**
 * Move a candidate out of `pending`. Throws when it is not pending, which rolls
 * back whatever else the answer wrote: an answer can only be given once.
 */
async function closeCandidate(
  tx: Tx,
  candidateId: string,
  set: Partial<typeof candidates.$inferInsert>,
): Promise<void> {
  const closed = await tx
    .update(candidates)
    .set({ ...set, answeredAt: new Date() })
    .where(and(eq(candidates.id, candidateId), eq(candidates.status, 'pending')))
    .returning({ id: candidates.id });
  if (closed.length === 0) throw new Error(`candidate ${candidateId} is not pending`);
}

export interface DecisionInput {
  userId: string;
  repoId: string | null;
  /** Absent for manual entry. */
  candidate?: StoredCandidate;
  role: DecisionRole;
  shape: DecisionShape;
  verdict: CostVerdict | null;
  /** Manual entry only; a candidate's anchor is copied from the candidate. */
  anchor?: { sha?: string; path?: string };
}

export async function recordDecision(db: Db, input: DecisionInput): Promise<string> {
  const now = new Date();
  const c = input.candidate;

  return db.transaction(async (tx) => {
    // Close the candidate first, so a second answer fails on "not pending"
    // rather than on the unique candidate_id — same rollback, clearer error.
    if (c !== undefined) {
      await closeCandidate(tx, c.id, {
        status: 'answered_decision',
        // "[a] I asked for it": the builder says the agent label was wrong.
        // Stored against the authorship version that made the call (G14).
        ...(input.role === 'directed' ? { authorshipDisputedAt: now } : {}),
      });
    }

    const [row] = await tx
      .insert(decisions)
      .values({
        userId: input.userId,
        repoId: input.repoId,
        candidateId: c?.id ?? null,
        origin: c === undefined ? 'entered_manually' : 'prompted_by_detection',
        role: input.role,
        anchorSha: c?.introducingSha ?? input.anchor?.sha ?? null,
        anchorPath: c?.filePath ?? input.anchor?.path ?? null,
        ...input.shape,
        ...verdictColumns(input.verdict, now),
      })
      .returning({ id: decisions.id });
    if (row === undefined) throw new Error('could not record the decision');

    return row.id;
  });
}

/**
 * Edit a decision's shape. The prior version goes to `decision_revisions`
 * first — without that, a record could be rewritten once the outcome was known
 * and nothing would show it. Role is not editable (enforced by trigger too).
 */
export async function reviseDecision(
  db: Db,
  decisionId: string,
  shape: DecisionShape,
  verdict: CostVerdict | null,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(decisions)
      .where(eq(decisions.id, decisionId))
      .for('update');
    if (current === undefined) throw new Error(`no decision ${decisionId}`);

    const [last] = await tx
      .select({ n: max(decisionRevisions.revisionNo) })
      .from(decisionRevisions)
      .where(eq(decisionRevisions.decisionId, decisionId));
    const revisionNo = (last?.n ?? 0) + 1;

    await tx.insert(decisionRevisions).values({
      decisionId,
      revisionNo,
      context: current.context,
      optionsConsidered: current.optionsConsidered,
      choice: current.choice,
      cost: current.cost,
      revisitCondition: current.revisitCondition,
    });
    await tx
      .update(decisions)
      .set({ ...shape, ...verdictColumns(verdict, new Date()), updatedAt: sql`now()` })
      .where(eq(decisions.id, decisionId));
    return revisionNo;
  });
}

/** "I didn't know that was a choice" — a learning goal, not a failure. */
export async function recordLearningGoal(
  db: Db,
  input: { userId: string; candidate?: StoredCandidate; title: string; note: string | null },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(learningGoals)
      .values({
        userId: input.userId,
        candidateId: input.candidate?.id ?? null,
        title: input.title,
        note: input.note,
      })
      .returning({ id: learningGoals.id });
    if (row === undefined) throw new Error('could not record the learning goal');
    if (input.candidate !== undefined) {
      await closeCandidate(tx, input.candidate.id, { status: 'answered_gap' });
    }
    return row.id;
  });
}

/** A labelled false positive for the detector: the tuning loop 0001 lacked. */
export async function dismissCandidate(
  db: Db,
  candidateId: string,
  reason: DismissalReason,
  note: string | null,
): Promise<void> {
  await db.transaction((tx) =>
    closeCandidate(tx, candidateId, { status: 'dismissed', dismissedReason: reason, dismissedNote: note }),
  );
}
