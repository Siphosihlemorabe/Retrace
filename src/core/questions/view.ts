/**
 * What a question looks like on screen (0009): the question, the code it is
 * about read fresh from the clone, who wrote it, and the outcome it belongs
 * to. Key points are never included: they are notes for judging (0011), and
 * showing them would hand over the answer.
 */
import { eq } from 'drizzle-orm';

import { outcomeSightings, skillOutcomes, skills } from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import { loadCandidate } from '../decisions/capture.js';
import { questionFor, type Question } from '../decisions/framing.js';
import type { Authorship } from '../detect/authorship.js';
import type { Repo } from '../git/index.js';
import { excerptAt } from './excerpt.js';
import type { StoredQuestion } from './queue.js';

export interface QuestionCard {
  id: string;
  kind: 'outcome_sighting' | 'outcome_untouched' | 'candidate';
  text: string;
  /** 'model' when a model read the code to write it; 'rule' when it was written without one. */
  foundBy: 'model' | 'rule';
  provider: string | null;
  shown: boolean;
  skipCount: number;
  outcome: { name: string; description: string; skill: string } | null;
  code: {
    sha: string;
    path: string;
    /** The lines the question is about. */
    lines: [number, number];
    authorship: Authorship;
    excerpt: { n: number; text: string }[];
  } | null;
  /** For a dependency decision: 0002's question, answered through its own flow. */
  decision: (Question & { candidateId: string }) | null;
}

export async function questionCard(db: Db, repo: Repo, q: StoredQuestion): Promise<QuestionCard> {
  let outcome: QuestionCard['outcome'] = null;
  if (q.outcomeId !== null) {
    const [o] = await db
      .select({ name: skillOutcomes.name, description: skillOutcomes.description, skill: skills.name })
      .from(skillOutcomes)
      .innerJoin(skills, eq(skills.id, skillOutcomes.skillId))
      .where(eq(skillOutcomes.id, q.outcomeId));
    outcome = o ?? null;
  }

  let code: QuestionCard['code'] = null;
  if (q.sightingId !== null && q.sha !== null && q.path !== null) {
    const [s] = await db.select().from(outcomeSightings).where(eq(outcomeSightings.id, q.sightingId));
    const lines: [number, number] = [q.lineStart ?? s?.lineStart ?? 1, q.lineEnd ?? s?.lineEnd ?? 1];
    const ex = await excerptAt(repo, q.sha, q.path, lines[0], lines[1]);
    code = {
      sha: q.sha,
      path: q.path,
      lines,
      authorship: (s?.authorship ?? 'unknown') as Authorship,
      excerpt: ex?.lines ?? [],
    };
  }

  let decision: QuestionCard['decision'] = null;
  if (q.candidateId !== null) {
    const candidate = await loadCandidate(db, q.userId, q.candidateId);
    if (candidate !== null) decision = { candidateId: candidate.id, ...questionFor(candidate, 1, 1) };
  }

  return {
    id: q.id,
    kind: q.targetKind as QuestionCard['kind'],
    text: q.text,
    foundBy: q.foundBy as 'model' | 'rule',
    provider: q.provider,
    shown: q.shownAt !== null,
    skipCount: q.skipCount,
    outcome,
    code,
    decision,
  };
}
