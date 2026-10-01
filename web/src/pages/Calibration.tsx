/** What the answers say about the detector and the authorship labels — never a score for you. */
import { useEffect, useState } from 'react';

import { api, type CalibrationResponse } from '../api.js';

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

export function CalibrationPage() {
  const [c, setC] = useState<CalibrationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.calibration().then(setC, (e: Error) => setError(e.message));
  }, []);

  if (error !== null) return <p className="error">{error}</p>;
  if (c === null) return <p className="muted">Loading…</p>;
  const disputed = c.disputes.reduce((n, d) => n + d.n, 0);

  return (
    <>
      <section className="card">
        <h2>Answers</h2>
        <div className="stats">
          <Stat label="shown" value={c.shown} />
          <Stat label="answered" value={c.answered} />
          <Stat label="answer rate" value={pct(c.answerRate)} />
        </div>
        <p className="muted small">
          Designed for one answer in five. With one builder this runs high; it means something with two.
        </p>
      </section>

      <section className="card">
        <h2>Where the detector was wrong</h2>
        {c.dismissals.length === 0 ? (
          <p className="muted">No dismissals yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Detector</th>
                <th>Reason</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {c.dismissals.map((d) => (
                <tr key={`${d.detectorVersion}-${d.reason}`}>
                  <td>v{d.detectorVersion}</td>
                  <td>{d.reason.replaceAll('_', ' ')}</td>
                  <td>{d.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Was the “your agent” label right?</h2>
        <p>
          {c.agentFramed} agent-framed answers · “I asked for it” {disputed}
          {c.agentFramed > 0 && ` (${pct(disputed / c.agentFramed)})`}
        </p>
        <p className="muted small">Over a third means the agent label is wrong for these repos.</p>
        {c.byRole.length > 0 && (
          <p className="small">Decisions by role: {c.byRole.map((r) => `${r.role} ${r.n}`).join(' · ')}</p>
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}
