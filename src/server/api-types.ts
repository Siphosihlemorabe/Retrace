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
import type { ModelScanResult } from '../core/outcomes/model-scan.js';
import type { QuestionCard } from '../core/questions/view.js';

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

// --- 0007: goals, coverage, code view ----------------------------------------

export interface SkillView {
  slug: string;
  name: string;
  outcomes: { slug: string; name: string; description: string }[];
}

export interface SkillsResponse {
  skills: SkillView[];
}

export interface GithubReadyResponse {
  ready: boolean;
}

export interface SetGoalsResponse {
  declaredAtSha: string;
  backfilled: number;
  alreadyTouched: number;
  goals: { goalId: string; skill: string; created: boolean; hasOutcomeList: boolean }[];
}

export interface ScanResponse {
  commits: number;
  sightings: number;
}

export interface CoverageResponse {
  /** "commit N" positions for every SHA the coverage mentions. */
  positions: Record<string, number>;
  commitCount: number;
  goals: {
    goalId: string;
    skill: { slug: string; name: string };
    declaredAtSha: string | null;
    declaredAt: string;
    hasOutcomeList: boolean;
    total: number;
    learned: number;
    percentLearned: number | null;
    touched: number;
    objective: { met: number; total: number };
    outcomes: {
      slug: string;
      name: string;
      description: string;
      inObjective: boolean;
      status: 'not_touched' | 'touched' | 'documented' | 'learned';
      sightings: {
        sha: string;
        path: string;
        lineStart: number;
        lineEnd: number;
        via: string;
        foundBy: string;
        authorship: string;
        when: 'before_goal' | 'after_goal';
      }[];
    }[];
  }[];
}

export interface CodeLineView {
  n: number;
  text: string;
  authorship: string;
  /** "you said", an agent's name, a template… */
  actor: string | null;
  relabelled: boolean;
}

export interface CodeViewResponse {
  sha: string;
  path: string;
  /** Where in history this commit sits. */
  position: number | null;
  lines: CodeLineView[];
  highlights: { start: number; end: number; outcome: string; name: string }[];
}

export interface LabelResponse {
  updated: number;
}

// --- 0009: model questions, settings, outcome lists ---------------------------

export type { QuestionCard } from '../core/questions/view.js';
export interface LlmStatusResponse {
  provider: 'claude-cli' | 'ollama' | 'anthropic-api' | 'off';
  model: string | null;
  sendsCodeOffMachine: boolean;
  callsToday: number;
  dailyCap: number;
  /** Set when RETRACE_LLM names something that can't be used. */
  error: string | null;
  questionsPerWeek: number;
}

export interface WeekResponse {
  budget: { limit: number; shownThisWeek: number; remaining: number };
  /** Whether this project's code may go to the connected model. Always true for a model on this machine. */
  modelAllowed: boolean;
  llm: Omit<LlmStatusResponse, 'questionsPerWeek'>;
  questions: QuestionCard[];
}

export interface SkipResponse {
  status: 'pending' | 'expired';
}

export interface DraftOutcomesResponse {
  /** Null when no model could draft one; `reason` says why. */
  outcomes: { name: string; description: string; lookFor: string[] }[] | null;
  reason: 'off' | 'capped' | 'failed' | null;
  message: string | null;
}

export interface SavedOutcomesResponse {
  slugs: string[];
  added: number;
  retired: number;
}

export type ModelScanResponse = ModelScanResult;
