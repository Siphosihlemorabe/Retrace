/**
 * Persisting detector output (0002 §1).
 *
 * Decided while building (0002 open question 4): **a candidate answered once
 * is never asked again, at any detector version.** A version bump re-detects
 * the same `(kind, subject, introducing SHA)`; if any earlier row for it was
 * answered, dismissed or expired, no new row is written. Answers are not
 * copied forward onto the new version's row — calibration groups dismissals
 * by detector version, and a v1 dismissal counted as v2's would be a lie.
 */
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';

import { candidates } from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import { toCandidateRow, type CandidateContext } from '../detect/candidate-row.js';
import { DETECTOR_VERSION, type RankedCandidate } from '../detect/rank.js';

export interface PersistResult {
  inserted: number;
  refreshed: number;
  /** Already answered at some version, so not stored again. */
  alreadyAnswered: number;
  /** Pending rows that no longer surface: deleted if never shown, else expired. */
  withdrawn: number;
}

const ANSWERED = ['answered_decision', 'answered_gap', 'dismissed', 'expired'];

/** Stable identity of a candidate across detector versions. */
const keyOf = (kind: string, subjectKey: string, sha: string) => `${kind}\u0000${subjectKey}\u0000${sha}`;

export async function persistCandidates(
  db: Db,
  ranked: readonly RankedCandidate[],
  ctx: CandidateContext,
): Promise<PersistResult> {
  return db.transaction(async (tx) => {
    const result: PersistResult = { inserted: 0, refreshed: 0, alreadyAnswered: 0, withdrawn: 0 };

    const answered = await tx
      .select({ kind: candidates.kind, subjectKey: candidates.subjectKey, sha: candidates.introducingSha })
      .from(candidates)
      .where(and(eq(candidates.repoId, ctx.repoId), inArray(candidates.status, ANSWERED)));
    const answeredKeys = new Set(answered.map((r) => keyOf(r.kind, r.subjectKey, r.sha)));

    const keptIds: string[] = [];
    for (const candidate of ranked) {
      if (candidate.suppressed !== null) continue;
      if (answeredKeys.has(keyOf(candidate.kind, candidate.subjectKey, candidate.sha))) {
        result.alreadyAnswered += 1;
        continue;
      }

      const row = toCandidateRow(candidate, ctx);
      const [written] = await tx
        .insert(candidates)
        .values(row)
        .onConflictDoUpdate({
          target: [
            candidates.repoId,
            candidates.kind,
            candidates.subjectKey,
            candidates.introducingSha,
            candidates.detectorVersion,
          ],
          // Only a pending row is refreshed: an answered candidate keeps the
          // authorship and score it was answered under.
          set: {
            rankScore: row.rankScore,
            signals: row.signals,
            introducedBy: row.introducedBy,
            introducingAuthorEmail: row.introducingAuthorEmail,
            authorshipVersion: row.authorshipVersion,
            commitCountAtDetection: row.commitCountAtDetection,
          },
          setWhere: eq(candidates.status, 'pending'),
        })
        .returning({ id: candidates.id, inserted: sql<boolean>`(xmax = 0)` });

      if (written === undefined) continue; // conflict on a non-pending row
      keptIds.push(written.id);
      if (written.inserted) result.inserted += 1;
      else result.refreshed += 1;
    }

    // A pending candidate that stopped surfacing (e.g. it turned out to be a
    // colleague's once identities were confirmed) must not be asked about.
    const stale = and(
      eq(candidates.repoId, ctx.repoId),
      eq(candidates.detectorVersion, DETECTOR_VERSION),
      eq(candidates.status, 'pending'),
      keptIds.length > 0 ? notInArray(candidates.id, keptIds) : undefined,
    );
    const deleted = await tx
      .delete(candidates)
      .where(and(stale, isNull(candidates.askedAt)))
      .returning({ id: candidates.id });
    const expired = await tx
      .update(candidates)
      .set({ status: 'expired' })
      .where(and(stale, isNotNull(candidates.askedAt)))
      .returning({ id: candidates.id });
    result.withdrawn = deleted.length + expired.length;

    return result;
  });
}
