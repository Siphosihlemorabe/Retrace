/**
 * The weekly ask budget (0002 §2, G6).
 *
 * A detector that asks about everything is no detector: people stop answering,
 * and unanswered prompts are worth nothing. So at most N candidates are shown
 * per rolling seven days, highest-ranked first.
 *
 * "Week" is rolling rather than calendar: no timezone, and no Monday cliff
 * where a fresh budget invites a burst of questions.
 */
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import { candidates } from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import type { Authorship } from '../detect/authorship.js';
import { fromCandidateRow, type StoredCandidate } from '../detect/candidate-row.js';
import { DETECTOR_VERSION } from '../detect/rank.js';

export const DEFAULT_WEEKLY_LIMIT = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Skips before a candidate stops being offered, rather than nagging forever. */
export const MAX_SKIPS = 3;

/**
 * Only authorship the capture flow can frame honestly (0003 §4). `unknown`
 * waits for the identity question; the rest are never stored as askable.
 */
export const ASKABLE: readonly Authorship[] = ['builder', 'builder_with_agent', 'agent'];

export interface Budget {
  limit: number;
  shownThisWeek: number;
  remaining: number;
}

export async function weeklyBudget(
  db: Db,
  userId: string,
  options: { limit?: number; now?: Date } = {},
): Promise<Budget> {
  const limit = options.limit ?? DEFAULT_WEEKLY_LIMIT;
  const since = new Date((options.now ?? new Date()).getTime() - WEEK_MS);
  const [row] = await db
    .select({ n: count() })
    .from(candidates)
    .where(and(eq(candidates.userId, userId), gte(candidates.askedAt, since)));
  const shownThisWeek = row?.n ?? 0;
  return { limit, shownThisWeek, remaining: Math.max(0, limit - shownThisWeek) };
}

/**
 * The next candidates to ask about, best first, within what is left of the
 * budget. Reads through `candidates_ask_budget_idx`.
 */
export async function nextCandidates(
  db: Db,
  userId: string,
  options: { limit?: number; now?: Date; repoId?: string } = {},
): Promise<StoredCandidate[]> {
  const { remaining } = await weeklyBudget(db, userId, options);
  if (remaining === 0) return [];

  const rows = await db
    .select()
    .from(candidates)
    .where(
      and(
        eq(candidates.userId, userId),
        eq(candidates.status, 'pending'),
        eq(candidates.detectorVersion, DETECTOR_VERSION),
        inArray(candidates.introducedBy, [...ASKABLE]),
        options.repoId === undefined ? undefined : eq(candidates.repoId, options.repoId),
      ),
    )
    .orderBy(desc(candidates.rankScore), desc(candidates.detectedAt))
    .limit(remaining);
  return rows.map(fromCandidateRow);
}

/** Called when a candidate is put on screen: this is what spends the budget. */
export async function markShown(db: Db, candidateId: string, now = new Date()): Promise<void> {
  await db.update(candidates).set({ askedAt: now }).where(eq(candidates.id, candidateId));
}

/** Back to the pool — or, on the third skip, out of it for good. */
export async function skipCandidate(db: Db, candidateId: string): Promise<'pending' | 'expired'> {
  const [row] = await db
    .update(candidates)
    .set({
      skipCount: sql`${candidates.skipCount} + 1`,
      status: sql`CASE WHEN ${candidates.skipCount} + 1 >= ${MAX_SKIPS} THEN 'expired' ELSE 'pending' END`,
    })
    .where(and(eq(candidates.id, candidateId), eq(candidates.status, 'pending')))
    .returning({ status: candidates.status });
  if (row === undefined) throw new Error(`candidate ${candidateId} is not pending`);
  return row.status as 'pending' | 'expired';
}
