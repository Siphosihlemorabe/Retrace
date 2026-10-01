/**
 * The web app's only way to the server. Types come from src/server/api-types,
 * imported type-only, so a contract change breaks the build on both sides.
 */
import type {
  Answer,
  AnswerResponse,
  CalibrationResponse,
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
};

export type * from '../../src/server/api-types.js';
