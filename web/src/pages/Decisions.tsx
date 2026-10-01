/** What has been recorded, and what each record is missing. Gaps are feedback, not failure. */
import { useEffect, useState } from 'react';

import { api, type DecisionView } from '../api.js';

const ROLE: Record<string, string> = {
  made: 'you made it',
  directed: 'you directed your agent',
  kept: "you kept your agent's choice",
};

export function DecisionsPage() {
  const [decisions, setDecisions] = useState<DecisionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.decisions().then(
      (r) => setDecisions(r.decisions),
      (e: Error) => setError(e.message),
    );
  }, []);

  if (error !== null) return <p className="error">{error}</p>;
  if (decisions === null) return <p className="muted">Loading…</p>;
  if (decisions.length === 0) {
    return (
      <section className="card">
        <h2>Nothing recorded yet</h2>
        <p className="muted">Answer a question on the Ask tab.</p>
      </section>
    );
  }

  return (
    <>
      {decisions.map((d) => (
        <section key={d.id} className="card">
          <h2>{d.choice ?? '(no choice written)'}</h2>
          <p className="muted small">
            {ROLE[d.role] ?? d.role} · {d.origin.replaceAll('_', ' ')}
            {d.repoName !== null && ` · ${d.repoName}`}
            {d.anchorSha !== null && <span className="mono"> · {d.anchorSha.slice(0, 7)}</span>}
            {d.anchorPath !== null && <span className="mono"> · {d.anchorPath}</span>}
          </p>
          <dl className="shape">
            {(
              [
                ['Context', d.context],
                ['Options', d.optionsConsidered],
                ['Cost', d.cost],
                ['Revisit', d.revisitCondition],
              ] as const
            ).map(([label, value]) =>
              value === null ? null : (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ),
            )}
          </dl>
          {d.missing.length === 0 ? (
            <p className="ok small">Complete.</p>
          ) : (
            <p className="small">
              <span className="muted">Still missing:</span> {d.missing.join(', ')}
            </p>
          )}
        </section>
      ))}
    </>
  );
}
