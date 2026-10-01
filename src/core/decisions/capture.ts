/**
 * The capture loop's steps, shared by every front end (CLI and the local web
 * UI, 0006). Both stay thin: if a question reads differently in one than the
 * other, the bug is that something escaped this file.
 */
import { and, eq } from 'drizzle-orm';

import { candidates, decisions } from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import { fromCandidateRow, type StoredCandidate } from '../detect/candidate-row.js';
import { detectDependencyDecisions } from '../detect/dependency.js';
import { parseManifest } from '../detect/manifest.js';
import { rank } from '../detect/rank.js';
import { showFile, trackedFiles, type Repo } from '../git/index.js';
import { skipCandidate } from './budget.js';
import { persistCandidates, type PersistResult } from './candidates.js';
import { checkCost, type CostContext, type CostVerdict } from './cost-check.js';
import { goalTitle } from './framing.js';
import { loadIdentitySet } from './identity.js';
import type { LocalClone } from './local.js';
import {
  dismissCandidate,
  recordDecision,
  recordLearningGoal,
  reviseDecision,
  type DecisionRole,
  type DecisionShape,
  type DismissalReason,
} from './record.js';

export const MANIFEST = 'package.json';

/** Repo facts without the choice: what the cost check can recognise as "this system". */
export type RepoCostContext = Omit<CostContext, 'choice' | 'alternative'>;

export async function costContextFor(repo: Repo): Promise<RepoCostContext> {
  const [manifestSource, paths] = await Promise.all([showFile(repo, 'HEAD', MANIFEST), trackedFiles(repo)]);
  const manifest = parseManifest(manifestSource);
  return { packageNames: manifest === null ? [] : [...manifest.keys()], paths };
}

/** Detect with the builder's current identities, and store what surfaced. */
export async function refreshCandidates(
  db: Db,
  repo: Repo,
  clone: LocalClone,
  userId: string,
): Promise<PersistResult> {
  const identities = await loadIdentitySet(db, userId);
  const detected = await detectDependencyDecisions(repo, { manifestPath: MANIFEST, identities });
  return persistCandidates(db, rank(detected.candidates).ranked, {
    repoId: clone.id,
    userId,
    manifestPath: MANIFEST,
  });
}

export async function loadCandidate(db: Db, userId: string, id: string): Promise<StoredCandidate | null> {
  const [row] = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.id, id), eq(candidates.userId, userId)));
  return row === undefined ? null : fromCandidateRow(row);
}

/** The cost context for one candidate: repo facts plus what was chosen over what. */
export function candidateCostContext(c: StoredCandidate, repo: RepoCostContext): CostContext {
  return { ...repo, choice: c.signals.packageName, alternative: c.signals.displaced };
}

export type Answer =
  | { kind: 'decision'; role: DecisionRole; shape: DecisionShape }
  | { kind: 'goal'; note: string | null }
  | { kind: 'dismiss'; reason: DismissalReason }
  | { kind: 'skip' };

export type AnswerResult =
  | { kind: 'decision'; decisionId: string; verdict: CostVerdict }
  | { kind: 'goal'; title: string }
  | { kind: 'dismissed' }
  | { kind: 'skipped'; status: 'pending' | 'expired' };

export async function answerCandidate(
  db: Db,
  input: { userId: string; repoId: string; candidate: StoredCandidate; answer: Answer; cost: CostContext },
): Promise<AnswerResult> {
  const { answer, candidate } = input;
  switch (answer.kind) {
    case 'skip':
      return { kind: 'skipped', status: await skipCandidate(db, candidate.id) };
    case 'dismiss':
      await dismissCandidate(db, candidate.id, answer.reason, null);
      return { kind: 'dismissed' };
    case 'goal': {
      const title = goalTitle(candidate);
      await recordLearningGoal(db, { userId: input.userId, candidate, title, note: answer.note });
      return { kind: 'goal', title };
    }
    case 'decision': {
      const verdict = checkCost(answer.shape.cost, input.cost);
      const decisionId = await recordDecision(db, {
        userId: input.userId,
        repoId: input.repoId,
        candidate,
        role: answer.role,
        shape: answer.shape,
        verdict,
      });
      return { kind: 'decision', decisionId, verdict };
    }
  }
}

/**
 * Revise a decision's shape and re-run the cost check against the same
 * context it was first judged in: what was chosen over what, and this repo.
 */
export async function reviseWithCheck(
  db: Db,
  userId: string,
  decisionId: string,
  shape: DecisionShape,
  repoCost: (repoId: string) => Promise<RepoCostContext>,
): Promise<CostVerdict | null> {
  const [d] = await db
    .select({ repoId: decisions.repoId, candidateId: decisions.candidateId })
    .from(decisions)
    .where(and(eq(decisions.id, decisionId), eq(decisions.userId, userId)));
  if (d === undefined) return null;

  const candidate = d.candidateId === null ? null : await loadCandidate(db, userId, d.candidateId);
  const repo = d.repoId === null ? { packageNames: [], paths: [] } : await repoCost(d.repoId);
  const cost: CostContext =
    candidate === null
      ? { ...repo, choice: shape.choice ?? 'this', alternative: null }
      : candidateCostContext(candidate, repo);

  const verdict = checkCost(shape.cost, cost);
  await reviseDecision(db, decisionId, shape, verdict);
  return verdict;
}

/** Manual entry (0002 §5): the builder's own words, a claim until anchored. */
export async function recordManual(
  db: Db,
  input: {
    userId: string;
    repoId: string;
    shape: DecisionShape;
    anchor: { sha?: string; path?: string };
    repo: RepoCostContext;
  },
): Promise<{ decisionId: string; verdict: CostVerdict }> {
  const verdict = checkCost(input.shape.cost, {
    ...input.repo,
    choice: input.shape.choice ?? 'this',
    alternative: null,
  });
  const decisionId = await recordDecision(db, {
    userId: input.userId,
    repoId: input.repoId,
    role: 'made',
    shape: input.shape,
    verdict,
    anchor: input.anchor,
  });
  return { decisionId, verdict };
}
