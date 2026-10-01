/**
 * Settings (0009): which model writes questions, how much of today's allowance
 * is left, and how many questions a week. The model is chosen in .env, not
 * here: it decides where code goes, so it stays a deliberate edit.
 */
import { useEffect, useState } from 'react';

import { api, type LlmStatusResponse } from '../api.js';
import { PROVIDER } from '../labels.js';

const MIN = 3;
const MAX = 50;

export function SettingsPage() {
  const [status, setStatus] = useState<LlmStatusResponse | null>(null);
  const [perWeek, setPerWeek] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.llm().then(
      (s) => {
        setStatus(s);
        setPerWeek(String(s.questionsPerWeek));
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  if (error !== null && status === null) return <p className="error">{error}</p>;
  if (status === null) return <p className="muted">Loading…</p>;

  const n = Number(perWeek);
  const valid = Number.isInteger(n) && n >= MIN && n <= MAX;

  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      const r = await api.setQuestionsPerWeek(n);
      setStatus({ ...status, questionsPerWeek: r.questionsPerWeek });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <section className="card">
        <h2>The model that writes questions</h2>
        <dl className="facts">
          <dt>Connected</dt>
          <dd>
            {PROVIDER[status.provider] ?? status.provider}
            {status.model !== null ? <span className="muted small"> · {status.model}</span> : null}
          </dd>
          <dt>Your code leaves this computer</dt>
          <dd>{status.provider === 'off' ? 'No' : status.sendsCodeOffMachine ? 'Yes, after you allow it per project' : 'No'}</dd>
          <dt>Model calls today</dt>
          <dd>
            {status.callsToday} of {status.dailyCap}
            <span className="muted small"> · when they run out, questions are written without the model until tomorrow</span>
          </dd>
        </dl>
        {status.error !== null && <p className="error">{status.error}</p>}
        <p className="muted small">
          To change it, set <code>RETRACE_LLM</code> in <code>.env</code> to <code>claude-cli</code>,{' '}
          <code>ollama</code>, <code>anthropic-api</code> or <code>off</code>, then restart the server. The daily
          allowance is <code>RETRACE_LLM_DAILY_CALLS</code>.
        </p>
      </section>

      <section className="card">
        <h2>Questions per week</h2>
        <p className="muted">
          Across every project, counted when a question is on screen. At least {MIN}: fewer and nothing gets
          explained.
        </p>
        <div className="actions">
          <input
            type="number"
            min={MIN}
            max={MAX}
            value={perWeek}
            onChange={(e) => {
              setPerWeek(e.target.value);
              setSaved(false);
            }}
            className="narrow"
          />
          <button className="primary" disabled={!valid || n === status.questionsPerWeek} onClick={() => void save()}>
            Save
          </button>
          {saved && <span className="ok">Saved.</span>}
          {!valid && perWeek !== '' && <span className="error small">Between {MIN} and {MAX}.</span>}
        </div>
        {error !== null && <p className="error">{error}</p>}
      </section>
    </>
  );
}
