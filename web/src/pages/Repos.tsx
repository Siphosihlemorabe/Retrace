/** Local clones this tool reads. Nothing is uploaded: it reads git history on this machine. */
import { useState } from 'react';

import { api, type RepoView } from '../api.js';

export function ReposPage({ repos, onAdded }: { repos: RepoView[]; onAdded: (repo: RepoView) => Promise<void> }) {
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
    <>
      <section className="card">
        <h2>Add a local clone</h2>
        <p className="muted small">
          The folder of a project on this computer that has git history. Nothing leaves your machine.
        </p>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="C:\Users\you\Projects\frontend-fixer"
          />
          <button className="primary" disabled={busy || path.trim() === ''}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </form>
        {error !== null && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <h2>Your repos</h2>
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
