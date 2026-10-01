/**
 * Projects this tool reads: start a new one, or add one you already have.
 * Nothing is uploaded — it reads git history on this machine. Creating the
 * repo on GitHub is opt-in, every time, because it changes your account.
 */
import { useEffect, useState } from 'react';

import { api, type RepoView } from '../api.js';

export function ReposPage({ repos, onAdded }: { repos: RepoView[]; onAdded: (repo: RepoView) => Promise<void> }) {
  return (
    <>
      <NewProject onAdded={onAdded} />
      <AddExisting onAdded={onAdded} />
      <section className="card">
        <h2>Your projects</h2>
        {repos.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="list">
            {repos.map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong> <span className="muted mono small">{r.path}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function NewProject({ onAdded }: { onAdded: (repo: RepoView) => Promise<void> }) {
  const [path, setPath] = useState('');
  const [ghReady, setGhReady] = useState<boolean | null>(null);
  const [onGithub, setOnGithub] = useState(false);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.githubReady().then((r) => setGhReady(r.ready), () => setGhReady(false));
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAdded(await api.createProject(path.trim(), onGithub ? visibility : undefined));
      setPath('');
      setOnGithub(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Start a new project</h2>
      <p className="muted small">
        Creates the folder with git set up and an empty first commit, so your goals are saved before any code exists.
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\you\Projects\my-new-app" />
        {ghReady === true && (
          <>
            <label className="check">
              <input type="checkbox" checked={onGithub} onChange={(e) => setOnGithub(e.target.checked)} /> Also create it on
              GitHub and push the first commit
            </label>
            {onGithub && (
              <div className="actions">
                <label className="check">
                  <input type="radio" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> Private
                </label>
                <label className="check">
                  <input type="radio" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> Public
                </label>
                <span className="muted small">This creates a repo on your GitHub account.</span>
              </div>
            )}
          </>
        )}
        {ghReady === false && (
          <p className="muted small">To also create it on GitHub, install GitHub's `gh` tool and run `gh auth login`.</p>
        )}
        <div className="actions">
          <button className="primary" disabled={busy || path.trim() === ''}>
            {busy ? 'Creating…' : onGithub ? `Create folder and ${visibility} GitHub repo` : 'Create folder'}
          </button>
        </div>
      </form>
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}

function AddExisting({ onAdded }: { onAdded: (repo: RepoView) => Promise<void> }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAdded(await api.addRepo(path.trim()));
      setPath('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Add a project you already have</h2>
      <p className="muted small">The folder of a project on this computer that has git history.</p>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\you\Projects\frontend-fixer" />
        <button className="primary" disabled={busy || path.trim() === ''}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}
