/**
 * Four tabs, no router: the capture loop is one screen at a time, and a
 * router library would be the first dependency 0006 said not to add.
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type RepoView } from './api.js';
import { AskPage } from './pages/Ask.js';
import { CalibrationPage } from './pages/Calibration.js';
import { DecisionsPage } from './pages/Decisions.js';
import { GoalsPage } from './pages/Goals.js';
import { ReposPage } from './pages/Repos.js';

type Tab = 'goals' | 'ask' | 'decisions' | 'calibration' | 'repos';
const TABS: { id: Tab; label: string }[] = [
  { id: 'goals', label: 'Goals' },
  { id: 'ask', label: 'Ask' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'repos', label: 'Projects' },
];

/** Remembered per browser only; losing it costs one click. */
const REPO_KEY = 'retrace.repoId';
const remembered = (): string | null => {
  try {
    return localStorage.getItem(REPO_KEY);
  } catch {
    return null;
  }
};
const remember = (id: string) => {
  try {
    localStorage.setItem(REPO_KEY, id);
  } catch {
    /* private window: fine */
  }
};

export function App() {
  const [tab, setTab] = useState<Tab>('goals');
  const [login, setLogin] = useState('');
  const [repos, setRepos] = useState<RepoView[] | null>(null);
  const [repoId, setRepoId] = useState<string | null>(remembered());
  const [error, setError] = useState<string | null>(null);

  const loadRepos = useCallback(async () => {
    try {
      const { repos } = await api.repos();
      setRepos(repos);
      setRepoId((current) => (current !== null && repos.some((r) => r.id === current) ? current : (repos[0]?.id ?? null)));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void api.me().then((me) => setLogin(me.login), (e: Error) => setError(e.message));
    void loadRepos();
  }, [loadRepos]);

  const pick = (id: string) => {
    setRepoId(id);
    remember(id);
  };

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          Retrace <span className="muted">· {login || '…'}</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {error !== null && <p className="error">{error}</p>}

      <main>
        {repos === null ? (
          <p className="muted">Loading…</p>
        ) : tab === 'goals' ? (
          <GoalsPage repos={repos} repoId={repoId} onPick={pick} onAddRepo={() => setTab('repos')} />
        ) : tab === 'ask' ? (
          <AskPage repos={repos} repoId={repoId} onPick={pick} onAddRepo={() => setTab('repos')} />
        ) : tab === 'decisions' ? (
          <DecisionsPage />
        ) : tab === 'calibration' ? (
          <CalibrationPage />
        ) : (
          <ReposPage
            repos={repos}
            onAdded={async (repo) => {
              await loadRepos();
              pick(repo.id);
              setTab('goals');
            }}
          />
        )}
      </main>
    </div>
  );
}
