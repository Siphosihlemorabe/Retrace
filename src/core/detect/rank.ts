/**
 * Scoring and suppression.
 *
 * The budget is the point. A detector that surfaces everything is the same as
 * no detector, because unanswered prompts are worth nothing — so the job here
 * is mostly deciding what *not* to show, and saying why.
 */
import type { Candidate, CandidateKind } from './dependency.js';

/** All the tuning in one place, so a ranking change is a visible diff. */
export const WEIGHTS = {
  alternative: 0.4,
  loadBearing: 0.25,
  deliberate: 0.35,
} as const;

/** Reversal only happens when the first option actually hurt. */
export const KIND_BONUS: Record<CandidateKind, number> = {
  replacement: 0.15,
  removal: 0.05,
  dependency_choice: 0,
};

export const THRESHOLD = 0.5;

/**
 * Stored on every candidate row and part of its dedupe key. Bump it whenever
 * the three tests, the weights, or the threshold change what a candidate
 * means — it lives here so a tuning change and its bump land in one diff.
 */
export const DETECTOR_VERSION = 1;

/** Imports beyond this add no further evidence of being load-bearing. */
const IMPORT_SATURATION = 5;

export type SuppressionReason =
  | 'no known alternative'
  | 'not load-bearing'
  | 'not deliberate'
  | 'below threshold';

export interface RankedCandidate extends Candidate {
  score: number;
  suppressed: SuppressionReason | null;
  suppressedDetail: string | null;
}

export interface RankSummary {
  total: number;
  surfaced: number;
  suppressed: Record<SuppressionReason, number>;
}

export interface RankResult {
  ranked: RankedCandidate[];
  summary: RankSummary;
}

export function scoreOf(candidate: Candidate): number {
  const { alternative, loadBearing, deliberate } = candidate.tests;

  const loadBearingScore = loadBearing.pass
    ? WEIGHTS.loadBearing *
      (candidate.kind === 'removal'
        ? 1
        : Math.min(1, candidate.importingFiles / IMPORT_SATURATION))
    : 0;

  const raw =
    (alternative.pass ? WEIGHTS.alternative : 0) +
    (deliberate.pass ? WEIGHTS.deliberate : 0) +
    loadBearingScore +
    KIND_BONUS[candidate.kind];

  return Math.round(Math.min(1, raw) * 100) / 100;
}

/**
 * Suppressed candidates keep their reason. During tuning the false negatives
 * are more informative than the hits, so `--all` has to be able to show why
 * something was dropped rather than just that it was.
 */
export function rank(candidates: Candidate[]): RankResult {
  const suppressed: Record<SuppressionReason, number> = {
    'no known alternative': 0,
    'not load-bearing': 0,
    'not deliberate': 0,
    'below threshold': 0,
  };

  const ranked: RankedCandidate[] = candidates.map((candidate) => {
    const score = scoreOf(candidate);
    const { alternative, loadBearing, deliberate } = candidate.tests;

    let reason: SuppressionReason | null = null;
    let detail: string | null = null;

    // Order matters: report the most fundamental failure, not the last one.
    if (!deliberate.pass) {
      reason = 'not deliberate';
      detail = deliberate.why;
    } else if (!alternative.pass) {
      reason = 'no known alternative';
      detail = alternative.why;
    } else if (!loadBearing.pass) {
      reason = 'not load-bearing';
      detail = loadBearing.why;
    } else if (score < THRESHOLD) {
      reason = 'below threshold';
      detail = `scored ${score.toFixed(2)}, threshold ${THRESHOLD.toFixed(2)}`;
    }

    if (reason !== null) suppressed[reason] += 1;

    return { ...candidate, score, suppressed: reason, suppressedDetail: detail };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.date.getTime() - a.date.getTime();
  });

  return {
    ranked,
    summary: {
      total: ranked.length,
      surfaced: ranked.filter((c) => c.suppressed === null).length,
      suppressed,
    },
  };
}
