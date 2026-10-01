/**
 * The API's response shapes, in one place. The web app imports this file
 * type-only, so the contract is checked at compile time on both sides and no
 * server code reaches the browser.
 */
import type { Budget } from '../core/decisions/budget.js';
import type { Calibration } from '../core/decisions/calibration.js';
import type { AnswerResult } from '../core/decisions/capture.js';
import type { CostVerdict } from '../core/decisions/cost-check.js';
import type { Question } from '../core/decisions/framing.js';
import type { PersistResult } from '../core/decisions/candidates.js';
import type { AuthorIdentity } from '../core/git/index.js';

export type { Answer, AnswerResult } from '../core/decisions/capture.js';
export type { CostVerdict } from '../core/decisions/cost-check.js';
export type { AnswerAction, AnswerOption, Question } from '../core/decisions/framing.js';
export type { DecisionRole, DecisionShape, DismissalReason } from '../core/decisions/record.js';

export interface ApiError {
  error: string;
}

export interface MeResponse {
  login: string;
}

export interface RepoView {
  id: string;
  name: string;
  path: string;
}

export interface ReposResponse {
  repos: RepoView[];
}

export interface IdentitiesResponse {
  /** Identities in this repo not yet answered for. Asked once each. */
  unresolved: AuthorIdentity[];
}

export type RefreshResponse = PersistResult;

export interface QuestionView extends Question {
  candidateId: string;
}

export interface QuestionsResponse {
  budget: Budget;
  questions: QuestionView[];
}

export type AnswerResponse = AnswerResult;

export interface ReviseResponse {
  verdict: CostVerdict;
}

export interface ManualResponse {
  decisionId: string;
  verdict: CostVerdict;
}

export interface DecisionView {
  id: string;
  role: string;
  origin: string;
  repoName: string | null;
  anchorSha: string | null;
  anchorPath: string | null;
  context: string | null;
  optionsConsidered: string | null;
  choice: string | null;
  cost: string | null;
  revisitCondition: string | null;
  costFeedback: string | null;
  missing: string[];
  createdAt: string;
}

export interface DecisionsResponse {
  decisions: DecisionView[];
}

export type CalibrationResponse = Calibration;
