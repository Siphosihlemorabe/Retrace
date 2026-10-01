/**
 * The capture loop, in a browser (0006): whose commits are these, then this
 * week's questions one at a time, worded exactly as the CLI words them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  api,
  type AnswerAction,
  type AnswerResponse,
  type CostVerdict,
  type DecisionRole,
  type DecisionShape,
  type IdentitiesResponse,
  type QuestionsResponse,
  type QuestionView,
  type RepoView,
} from '../api.js';

export type Identity = IdentitiesResponse['unresolved'][number];

const LIMITS = [3, 5, 10];

export function AskPage(props: {
  repos: RepoView[];
  repoId: string | null;
  onPick: (id: string) => void;
  onAddRepo: () => void;
}) {
  const { repos, repoId, onPick, onAddRepo } = props;
  const [limit, setLimit] = useState(3);

  if (repos.length === 0) {
    return (
      <section className="card">
        <h2>No repos yet</h2>
        <p>Add a local clone of one of your projects to start.</p>
        <button className="primary" onClick={onAddRepo}>
          Add a repo
        </button>
      </section>
    );
  }

  return (
    <>
      <div className="toolbar">
        <label>
          Repo{' '}
          <select value={repoId ?? ''} onChange={(e) => onPick(e.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Questions per week{' '}
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
                {n === 3 ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      {repoId !== null && <AskFlow key={`${repoId}:${limit}`} repoId={repoId} limit={limit} />}
      {repoId !== null && <ManualEntry repoId={repoId} />}
    </>
  );
}

// ---------------------------------------------------------------------------

function AskFlow({ repoId, limit }: { repoId: string; limit: number }) {
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [data, setData] = useState<QuestionsResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadQuestions = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.refresh(repoId);
      setData(await api.questions(repoId, limit));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [repoId, limit]);

  useEffect(() => {
    void api.identities(repoId).then(
      ({ unresolved }) => {
        setIdentities(unresolved);
        if (unresolved.length === 0) void loadQuestions();
        else setBusy(false);
      },
      (e: Error) => {
        setError(e.message);
        setBusy(false);
      },
    );
  }, [repoId, loadQuestions]);

  if (error !== null) return <p className="error">{error}</p>;

  if (identities !== null && identities.length > 0) {
    return (
      <IdentityStep
        identity={identities[0] as Identity}
        remaining={identities.length}
        onDone={() => {
          const rest = identities.slice(1);
          setIdentities(rest);
          if (rest.length === 0) void loadQuestions();
        }}
      />
    );
  }

  if (busy || data === null) return <p className="muted">Reading the repo’s history…</p>;

  const question = data.questions[0];
  if (question === undefined) {
    return (
      <section className="card">
        {data.budget.remaining === 0 ? (
          <>
            <h2>That’s this week’s {data.budget.limit}</h2>
            <p className="muted">
              {data.budget.shownThisWeek} shown in the last seven days. More next week — or raise “questions per
              week” above while you’re testing.
            </p>
          </>
        ) : (
          <>
            <h2>Nothing to ask about here right now</h2>
            <p className="muted">The detector found no open choices in this repo worth a question.</p>
          </>
        )}
      </section>
    );
  }

  return <QuestionCard key={question.candidateId} question={question} onNext={() => void loadQuestions()} />;
}

// ---------------------------------------------------------------------------

export function IdentityStep(props: { identity: Identity; remaining: number; onDone: () => void }) {
  const { identity, remaining, onDone } = props;
  const [error, setError] = useState<string | null>(null);

  const answer = async (verdict: 'me' | 'other' | 'later') => {
    try {
      if (verdict !== 'later') await api.answerIdentity(identity.email, identity.name, verdict);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card">
      <p className="eyebrow">First, whose commits are these? Asked once per identity · {remaining} to go</p>
      <h2>
        Who is “{identity.name}”?
      </h2>
      <p className="mono">{identity.email}</p>
      <p className="muted">
        {identity.commits} commit{identity.commits === 1 ? '' : 's'} in this repo
      </p>
      <div className="actions">
        <button className="primary" onClick={() => void answer('me')}>
          Me
        </button>
        <button onClick={() => void answer('other')}>Someone else</button>
        <button className="quiet" onClick={() => void answer('later')}>
          Ask me later
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------

type Mode =
  | { kind: 'choosing' }
  | { kind: 'decision'; role: DecisionRole }
  | { kind: 'goal' }
  | { kind: 'trivia' }
  | { kind: 'done'; result: AnswerResponse };

function QuestionCard({ question, onNext }: { question: QuestionView; onNext: () => void }) {
  const [mode, setMode] = useState<Mode>({ kind: 'choosing' });
  const [error, setError] = useState<string | null>(null);
  const reported = useRef(false);

  // Showing spends the budget — report it once, when the question is on screen.
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    void api.shown(question.candidateId).catch((e: Error) => setError(e.message));
  }, [question.candidateId]);

  const send = async (answer: Parameters<typeof api.answer>[1]) => {
    setError(null);
    try {
      setMode({ kind: 'done', result: await api.answer(question.candidateId, answer) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const choose = (action: AnswerAction) => {
    switch (action.kind) {
      case 'decision':
        return setMode({ kind: 'decision', role: action.role });
      case 'goal':
        return setMode({ kind: 'goal' });
      case 'not_a_choice_or_trivia':
        return setMode({ kind: 'trivia' });
      case 'dismiss':
        return void send({ kind: 'dismiss', reason: action.reason });
      case 'skip':
        return void send({ kind: 'skip' });
    }
  };

  return (
    <section className="card">
      <p className="eyebrow">{question.headline.split(' · ')[0]}</p>
      <h2 className="mono subject">{question.headline.split(' · ').slice(1).join(' · ')}</h2>
      {question.details.map((d) => (
        <p key={d} className="muted mono small">
          {d}
        </p>
      ))}

      <h3>{question.prompt}</h3>

      {mode.kind === 'choosing' && (
        <div className="options">
          {question.options.map((o) => (
            <button key={o.key} className={o.action.kind === 'skip' ? 'option quiet' : 'option'} onClick={() => choose(o.action)}>
              {o.label}
            </button>
          ))}
        </div>
      )}

      {mode.kind === 'decision' && (
        <DecisionForm
          prefill={question.choice}
          onCancel={() => setMode({ kind: 'choosing' })}
          onSave={(shape) => send({ kind: 'decision', role: mode.role, shape })}
        />
      )}

      {mode.kind === 'goal' && <GoalForm onCancel={() => setMode({ kind: 'choosing' })} onSave={(note) => send({ kind: 'goal', note })} />}

      {mode.kind === 'trivia' && (
        <div className="options">
          <button className="option" onClick={() => void send({ kind: 'dismiss', reason: 'not_a_choice' })}>
            There was no real alternative
          </button>
          <button className="option" onClick={() => void send({ kind: 'dismiss', reason: 'not_load_bearing' })}>
            Nothing depends on it
          </button>
          <button className="quiet" onClick={() => setMode({ kind: 'choosing' })}>
            Back
          </button>
        </div>
      )}

      {mode.kind === 'done' && <Outcome result={mode.result} onNext={onNext} />}
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}

function Outcome({ result, onNext }: { result: AnswerResponse; onNext: () => void }) {
  return (
    <div className="outcome">
      {result.kind === 'decision' && <Revisable decisionId={result.decisionId} first={result.verdict} />}
      {result.kind === 'goal' && <p className="ok">Learning goal saved: {result.title}</p>}
      {result.kind === 'dismissed' && <p className="ok">Noted — that tells the detector it got this one wrong.</p>}
      {result.kind === 'skipped' && (
        <p className="ok">{result.status === 'expired' ? 'Skipped three times — it won’t come up again.' : 'Skipped. It may come back.'}</p>
      )}
      <button className="primary" onClick={onNext}>
        Next question
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

const EMPTY: DecisionShape = { choice: null, context: null, optionsConsidered: null, cost: null, revisitCondition: null };

const FIELDS: { key: keyof DecisionShape; label: string; hint: string }[] = [
  { key: 'choice', label: 'Choice', hint: 'What was chosen, over what' },
  { key: 'context', label: 'Context', hint: 'What was going on at the time' },
  { key: 'optionsConsidered', label: 'Options', hint: 'What else was possible' },
  { key: 'cost', label: 'Cost', hint: 'What did this give up, in this codebase?' },
  { key: 'revisitCondition', label: 'Revisit', hint: 'When would you change your mind? (optional)' },
];

function DecisionForm(props: { prefill: string | null; onSave: (shape: DecisionShape) => void; onCancel: () => void }) {
  const [shape, setShape] = useState<DecisionShape>({ ...EMPTY, choice: props.prefill });
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave(shape);
      }}
    >
      <p className="muted small">Every field is optional. A record with only a cost is still worth keeping.</p>
      {FIELDS.map((f) => (
        <label key={f.key} className="field">
          <span>{f.label}</span>
          <textarea
            rows={f.key === 'cost' ? 3 : 2}
            placeholder={f.hint}
            value={shape[f.key] ?? ''}
            onChange={(e) => setShape({ ...shape, [f.key]: e.target.value })}
          />
        </label>
      ))}
      <div className="actions">
        <button type="submit" className="primary">
          Save
        </button>
        <button type="button" className="quiet" onClick={props.onCancel}>
          Back
        </button>
      </div>
    </form>
  );
}

function GoalForm(props: { onSave: (note: string | null) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave(note.trim() === '' ? null : note);
      }}
    >
      <p className="muted small">Not knowing is useful — this becomes something to learn, not a mark against you.</p>
      <label className="field">
        <span>What would you want to understand about it?</span>
        <textarea rows={2} placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" className="primary">
          Save learning goal
        </button>
        <button type="button" className="quiet" onClick={props.onCancel}>
          Back
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

/** The cost check's verdict, with a revision box until both parts pass. */
function Revisable({ decisionId, first, shape }: { decisionId: string; first: CostVerdict; shape?: DecisionShape }) {
  const [verdict, setVerdict] = useState(first);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState(0);
  const passed = verdict.namesLoss && verdict.systemSpecific;

  const revise = async () => {
    setError(null);
    try {
      // The server keeps the earlier version in decision_revisions.
      const current = await currentShape(decisionId, shape);
      setVerdict((await api.revise(decisionId, { ...current, cost: draft })).verdict);
      setRevisions((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="verdict">
      <p>
        <strong>Cost check:</strong> names a loss <Mark ok={verdict.namesLoss} /> · specific to this system{' '}
        <Mark ok={verdict.systemSpecific} />
      </p>
      {verdict.feedback.map((f) => (
        <p key={f} className="feedback">
          {f}
        </p>
      ))}
      {passed ? (
        <p className="ok">Saved{revisions > 0 ? ` — your earlier ${revisions === 1 ? 'version is' : 'versions are'} kept too` : ''}.</p>
      ) : (
        <div className="form">
          <label className="field">
            <span>Revise the cost (optional)</span>
            <textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What did you lose, and where in this codebase?" />
          </label>
          <div className="actions">
            <button onClick={() => void revise()} disabled={draft.trim() === ''}>
              Check again
            </button>
            <span className="muted small">Already saved as written. Revising keeps both.</span>
          </div>
        </div>
      )}
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}

/** The decision's other fields, so a cost revision does not blank them. */
async function currentShape(decisionId: string, known?: DecisionShape): Promise<DecisionShape> {
  if (known !== undefined) return known;
  const { decisions } = await api.decisions();
  const d = decisions.find((x) => x.id === decisionId);
  return d === undefined
    ? EMPTY
    : {
        choice: d.choice,
        context: d.context,
        optionsConsidered: d.optionsConsidered,
        cost: d.cost,
        revisitCondition: d.revisitCondition,
      };
}

function Mark({ ok }: { ok: boolean }) {
  return <span className={ok ? 'mark yes' : 'mark no'}>{ok ? '✓' : '✗'}</span>;
}

// ---------------------------------------------------------------------------

function ManualEntry({ repoId }: { repoId: string }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<{ id: string; verdict: CostVerdict; shape: DecisionShape } | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <p className="muted small manual-link">
        Know a decision the detector can’t see?{' '}
        <button className="link" onClick={() => setOpen(true)}>
          Write it by hand
        </button>
      </p>
    );
  }

  return (
    <section className="card">
      <h2>A decision in your own words</h2>
      <p className="muted small">Entered by hand, it stays a claim, not evidence.</p>
      {saved === null ? (
        <>
          <label className="field">
            <span>File it’s about (optional)</span>
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="src/App.tsx" />
          </label>
          <DecisionForm
            prefill={null}
            onCancel={() => setOpen(false)}
            onSave={(shape) => {
              setError(null);
              api
                .manual(repoId, shape, path.trim() === '' ? {} : { path: path.trim() })
                .then((r) => setSaved({ id: r.decisionId, verdict: r.verdict, shape }), (e: Error) => setError(e.message));
            }}
          />
        </>
      ) : (
        <>
          <Revisable decisionId={saved.id} first={saved.verdict} shape={saved.shape} />
          <button
            onClick={() => {
              setSaved(null);
              setOpen(false);
            }}
          >
            Done
          </button>
        </>
      )}
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}
