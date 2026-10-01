/**
 * What the answers say about the detector (0002 `--calibration`) and about
 * authorship (0003). Dismissals are labelled false positives; authorship
 * disputes are labelled mis-framings. Together they are the tuning data.
 *
 * Everything here is about candidates and judges, never a score for the
 * person (G2).
 */
import { and, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { candidates, decisions } from '../../db/schema.js';
import type { Db } from '../../db/types.js';

export interface Calibration {
  shown: number;
  answered: number;
  /** answered ÷ shown. CLAUDE.md designs for one in five; the builder will run higher. */
  answerRate: number | null;
  dismissals: { detectorVersion: number; reason: string; n: number }[];
  /** Agent-framed answers, and how many of them said "[a] I asked for it". */
  agentFramed: number;
  disputes: { authorshipVersion: number; n: number }[];
  byRole: { role: string; n: number }[];
}

const ANSWERED = ['answered_decision', 'answered_gap', 'dismissed'];

export async function calibration(db: Db, userId: string): Promise<Calibration> {
  const mine = eq(candidates.userId, userId);

  const [[shown], [answered], dismissals, [agentFramed], disputes, byRole] = await Promise.all([
    db.select({ n: count() }).from(candidates).where(and(mine, isNotNull(candidates.askedAt))),
    db.select({ n: count() }).from(candidates).where(and(mine, inArray(candidates.status, ANSWERED))),
    db
      .select({
        detectorVersion: candidates.detectorVersion,
        reason: sql<string>`${candidates.dismissedReason}`,
        n: count(),
      })
      .from(candidates)
      .where(and(mine, eq(candidates.status, 'dismissed')))
      .groupBy(candidates.detectorVersion, candidates.dismissedReason)
      .orderBy(candidates.detectorVersion, candidates.dismissedReason),
    db
      .select({ n: count() })
      .from(candidates)
      .where(and(mine, eq(candidates.introducedBy, 'agent'), inArray(candidates.status, ANSWERED))),
    db
      .select({ authorshipVersion: candidates.authorshipVersion, n: count() })
      .from(candidates)
      .where(and(mine, isNotNull(candidates.authorshipDisputedAt)))
      .groupBy(candidates.authorshipVersion),
    db
      .select({ role: decisions.role, n: count() })
      .from(decisions)
      .where(eq(decisions.userId, userId))
      .groupBy(decisions.role),
  ]);

  const s = shown?.n ?? 0;
  const a = answered?.n ?? 0;
  return {
    shown: s,
    answered: a,
    answerRate: s === 0 ? null : a / s,
    dismissals,
    agentFramed: agentFramed?.n ?? 0,
    disputes,
    byRole,
  };
}
