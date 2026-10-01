/**
 * `npm run decisions` — what has been recorded, and what each record is
 * missing. Missing parts are feedback, not failure: a record with only a cost
 * is still worth keeping (0002 §3).
 */
import { desc, eq } from 'drizzle-orm';

import { decisions, repos } from '../../db/schema.js';
import type { Db } from '../../db/types.js';

export type DecisionRecord = typeof decisions.$inferSelect & { repoName: string | null };

const SHAPE = [
  ['context', 'context'],
  ['optionsConsidered', 'options considered'],
  ['choice', 'choice'],
  ['cost', 'cost'],
  ['revisitCondition', 'revisit condition'],
] as const;

/** Which parts of the shape are empty, and which cost checks failed. Pure. */
export function missingParts(d: typeof decisions.$inferSelect): string[] {
  const missing: string[] = SHAPE.filter(([key]) => (d[key] ?? '').trim() === '').map(([, label]) => label);
  if ((d.cost ?? '').trim() !== '') {
    if (d.costNamesLoss === false) missing.push('a cost that names a loss');
    if (d.costIsSystemSpecific === false) missing.push('a cost specific to this system');
  }
  return missing;
}

export async function listDecisions(db: Db, userId: string): Promise<DecisionRecord[]> {
  const rows = await db
    .select({ d: decisions, repoName: repos.name })
    .from(decisions)
    .leftJoin(repos, eq(repos.id, decisions.repoId))
    .where(eq(decisions.userId, userId))
    .orderBy(desc(decisions.createdAt));
  return rows.map((r) => ({ ...r.d, repoName: r.repoName }));
}
