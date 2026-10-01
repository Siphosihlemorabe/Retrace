/**
 * RankedCandidate ⇄ `candidates` row. Pure: no database, no git.
 *
 * Columns that ranking or the budget query read are promoted; everything the
 * `ask` screen needs to show the candidate again lives in `signals`, so a
 * stored candidate can be displayed without re-running the detector.
 */
import type { candidates } from '../../db/schema.js';
import type { Authorship, CommitAuthorship } from './authorship.js';
import { AUTHORSHIP_VERSION } from './authorship.js';
import type { CandidateKind, TestResult } from './dependency.js';
import { DETECTOR_VERSION, type RankedCandidate } from './rank.js';

export type CandidateInsert = typeof candidates.$inferInsert;
export type CandidateRow = typeof candidates.$inferSelect;

/** What `signals` holds. Versioned implicitly by `detector_version`. */
export interface CandidateSignals {
  packageName: string;
  displaced: string | null;
  category: string | null;
  categoryLabel: string | null;
  commitSubject: string;
  /** Git's date: display only, never a trust claim (G8). */
  commitDate: string;
  importingFiles: number;
  tests: { alternative: TestResult; loadBearing: TestResult; deliberate: TestResult };
  authorshipRule: string;
  authorshipActor: string | null;
}

export interface CandidateContext {
  repoId: string;
  userId: string;
  manifestPath: string;
}

export function toCandidateRow(c: RankedCandidate, ctx: CandidateContext): CandidateInsert {
  const signals: CandidateSignals = {
    packageName: c.packageName,
    displaced: c.displaced,
    category: c.category,
    categoryLabel: c.categoryLabel,
    commitSubject: c.subject,
    commitDate: c.date.toISOString(),
    importingFiles: c.importingFiles,
    tests: c.tests,
    authorshipRule: c.authorship.rule,
    authorshipActor: c.authorship.actor,
  };

  return {
    repoId: ctx.repoId,
    userId: ctx.userId,
    kind: c.kind,
    subjectKind: 'dependency',
    subjectKey: c.subjectKey,
    displacedSubjectKey: c.displaced === null ? null : `npm:${c.displaced}`,
    introducingSha: c.sha,
    filePath: ctx.manifestPath,
    filesInIntroducingCommit: c.filesInCommit,
    introducedAlone: c.introducedAlone,
    looksScaffoldGenerated: c.looksScaffoldGenerated,
    commitIndexAtIntroduction: c.commitIndex,
    commitCountAtDetection: c.commitCount,
    introducedBy: c.authorship.authorship,
    introducingAuthorEmail: c.authorEmail.toLowerCase(),
    authorshipVersion: AUTHORSHIP_VERSION,
    signals,
    rankScore: c.score.toFixed(4),
    detectorVersion: DETECTOR_VERSION,
  };
}

/** A stored candidate, in the shape the capture flow shows and answers. */
export interface StoredCandidate {
  id: string;
  repoId: string;
  kind: CandidateKind;
  subjectKey: string;
  introducingSha: string;
  /** The anchor file: for dependency candidates, the manifest walked. */
  filePath: string | null;
  filesInCommit: number | null;
  commitIndex: number | null;
  commitCount: number | null;
  authorship: CommitAuthorship;
  authorEmail: string;
  score: number;
  status: string;
  skipCount: number;
  signals: CandidateSignals;
}

export function fromCandidateRow(row: CandidateRow): StoredCandidate {
  const signals = row.signals as CandidateSignals;
  return {
    id: row.id,
    repoId: row.repoId,
    kind: row.kind as CandidateKind,
    subjectKey: row.subjectKey,
    introducingSha: row.introducingSha,
    filePath: row.filePath,
    filesInCommit: row.filesInIntroducingCommit,
    commitIndex: row.commitIndexAtIntroduction,
    commitCount: row.commitCountAtDetection,
    authorship: {
      authorship: row.introducedBy as Authorship,
      rule: signals.authorshipRule,
      actor: signals.authorshipActor,
    },
    authorEmail: row.introducingAuthorEmail ?? '',
    score: Number(row.rankScore ?? 0),
    status: row.status,
    skipCount: row.skipCount,
    signals,
  };
}
