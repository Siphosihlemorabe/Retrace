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
const TABS: { id: Tab; label: string; title: string; subtitle: string }[] = [
  {
    id: 'goals',
    label: 'Goals',
    title: 'Learning goals',
    subtitle: 'What you set out to learn in each project, what your code touches, and who wrote it.',
  },
  {
    id: 'ask',
    label: 'Ask',
    title: "This week's questions",
    subtitle: 'A few questions about real choices in your code. Explain them in your own words.',
  },
  {
    id: 'decisions',
    label: 'Decisions',
    title: 'Your decisions',
    subtitle: 'Choices you have documented: what you chose, what it cost, and what is still missing.',
  },
  {
    id: 'calibration',
    label: 'Calibration',
    title: 'Calibration',
    subtitle: 'What your answers say about the questions. About the tool, never a score for you.',
  },
  {
    id: 'repos',
    label: 'Projects',
    title: 'Projects',
    subtitle: 'Start a new project or add one you have. Everything stays on this computer.',
  },
];

/** The mark: a path doubling back on itself — retracing your steps. */
function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" className="logo-bg" />
      <path d="M9 22V12a4 4 0 0 1 4-4h6a4 4 0 0 1 0 8h-6l8 7" className="logo-path" />
    </svg>
  );
}

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

  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <Logo />
            <span className="brand-name">Retrace</span>
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={t.id === tab ? 'tab active' : 'tab'}
                aria-current={t.id === tab ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="user" title="Signed in from your .env">
            <span className="avatar">{(login || '?').slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{login || '…'}</span>
          </div>
        </div>
      </header>

      <div className="shell">
      <div className="page-head">
        <h1>{current.title}</h1>
        <p>{current.subtitle}</p>
      </div>

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
    </div>
  );
}
