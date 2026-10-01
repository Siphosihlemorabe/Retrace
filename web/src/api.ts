/**
 * The web app's only way to the server. Types come from src/server/api-types,
 * imported type-only, so a contract change breaks the build on both sides.
 */
import type {
  Answer,
  AnswerResponse,
  CalibrationResponse,
  CodeViewResponse,
  CoverageResponse,
  DraftOutcomesResponse,
  LlmStatusResponse,
  ModelScanResponse,
  SavedOutcomesResponse,
  SkipResponse,
  WeekResponse,
  GithubReadyResponse,
  LabelResponse,
  ScanResponse,
  SetGoalsResponse,
  SkillsResponse,
  DecisionShape,
  DecisionsResponse,
  IdentitiesResponse,
  ManualResponse,
  MeResponse,
  QuestionsResponse,
  RefreshResponse,
  ReposResponse,
  RepoView,
  ReviseResponse,
} from '../../src/server/api-types.js';

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body });

export const api = {
  me: () => request<MeResponse>('/api/me'),
  repos: () => request<ReposResponse>('/api/repos'),
  addRepo: (path: string) => post<RepoView>('/api/repos', { path }),
  identities: (repoId: string) => request<IdentitiesResponse>(`/api/repos/${repoId}/identities`),
  answerIdentity: (email: string, name: string, verdict: 'me' | 'other') =>
    post<{ ok: true }>('/api/identities', { email, name, verdict }),
  refresh: (repoId: string) => post<RefreshResponse>(`/api/repos/${repoId}/refresh`),
  questions: (repoId: string, limit: number) =>
    request<QuestionsResponse>(`/api/repos/${repoId}/questions?limit=${limit}`),
  shown: (candidateId: string) => post<{ ok: true }>(`/api/candidates/${candidateId}/shown`),
  answer: (candidateId: string, answer: Answer) => post<AnswerResponse>(`/api/candidates/${candidateId}/answer`, answer),
  revise: (decisionId: string, shape: DecisionShape) =>
    post<ReviseResponse>(`/api/decisions/${decisionId}/revise`, { shape }),
  manual: (repoId: string, shape: DecisionShape, anchor: { sha?: string; path?: string }) =>
    post<ManualResponse>(`/api/repos/${repoId}/manual`, { shape, anchor }),
  decisions: () => request<DecisionsResponse>('/api/decisions'),
  calibration: () => request<CalibrationResponse>('/api/calibration'),

  // 0007
  skills: () => request<SkillsResponse>('/api/skills'),
  githubReady: () => request<GithubReadyResponse>('/api/github-ready'),
  createProject: (path: string, github?: 'private' | 'public') =>
    post<RepoView>('/api/projects', github === undefined ? { path } : { path, github }),
  setGoals: (repoId: string, goals: { name: string; objective: 'all' | string[] }[]) =>
    post<SetGoalsResponse>(`/api/repos/${repoId}/goals`, { goals }),
  scan: (repoId: string) => post<ScanResponse>(`/api/repos/${repoId}/scan`),
  coverage: (repoId: string) => request<CoverageResponse>(`/api/repos/${repoId}/coverage`),
  code: (repoId: string, sha: string, path: string) =>
    request<CodeViewResponse>(`/api/repos/${repoId}/code?sha=${sha}&path=${encodeURIComponent(path)}`),
  label: (repoId: string, body: { sha: string; path: string; lineStart: number; lineEnd: number; label: 'agent' | 'me' }) =>
    post<LabelResponse>(`/api/repos/${repoId}/labels`, body),

  // 0009
  llm: () => request<LlmStatusResponse>('/api/llm'),
  setQuestionsPerWeek: (n: number) => put<{ questionsPerWeek: number }>('/api/settings', { questionsPerWeek: n }),
  allowModel: (repoId: string) => post<{ ok: true }>(`/api/repos/${repoId}/llm-consent`),
  week: (repoId: string) => request<WeekResponse>(`/api/repos/${repoId}/week`),
  questionShown: (id: string) => post<{ ok: true }>(`/api/questions/${id}/shown`),
  practice: (id: string, answer: string) => post<{ ok: true }>(`/api/questions/${id}/answer`, { answer }),
  skipQuestion: (id: string) => post<SkipResponse>(`/api/questions/${id}/skip`),
  draftOutcomes: (skill: string) => post<DraftOutcomesResponse>(`/api/skills/${encodeURIComponent(skill)}/draft`),
  saveOutcomes: (skill: string, outcomes: { name: string; description: string; lookFor: string[]; slug?: string }[]) =>
    put<SavedOutcomesResponse>(`/api/skills/${encodeURIComponent(skill)}/outcomes`, { outcomes }),
  modelScan: (repoId: string, skill: string) => post<ModelScanResponse>(`/api/repos/${repoId}/model-scan`, { skill }),
};

export type * from '../../src/server/api-types.js';
