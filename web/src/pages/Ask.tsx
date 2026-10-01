/**
 * This week's questions (0006, 0009): whose commits are these, then one
 * question at a time. A question about code a goal touches shows the lines and
 * takes an answer in your own words; a dependency decision keeps 0002's flow.
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
  type QuestionCard as Card,
  type QuestionView,
  type RepoView,
  type WeekResponse,
} from '../api.js';
import { PROVIDER, WHO } from '../labels.js';

export type Identity = IdentitiesResponse['unresolved'][number];

export function AskPage(props: {
  repos: RepoView[];
  repoId: string | null;
  onPick: (id: string) => void;
  onAddRepo: () => void;
}) {
  const { repos, repoId, onPick, onAddRepo } = props;

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
        <span className="muted small">How many a week is in Settings.</span>
      </div>
      {repoId !== null && <AskFlow key={repoId} repoId={repoId} />}
      {repoId !== null && <ManualEntry repoId={repoId} />}
    </>
  );
}

// ---------------------------------------------------------------------------

function AskFlow({ repoId }: { repoId: string }) {
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [data, setData] = useState<WeekResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [consentLater, setConsentLater] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadQuestions = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // New commits first: dependency choices, then code that touches your goals.
      await api.refresh(repoId);
      await api.scan(repoId);
      setData(await api.week(repoId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [repoId]);

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

  const askConsent = !data.modelAllowed && data.llm.provider !== 'off' && !consentLater;
  const card = data.questions[0];
  const position = Math.min(data.budget.limit, data.budget.shownThisWeek + (card?.shown === true ? 0 : 1));

  return (
    <>
      {askConsent && (
        <ConsentBanner
          provider={data.llm.provider}
          onAllow={async () => {
            await api.allowModel(repoId);
            await loadQuestions();
          }}
          onLater={() => setConsentLater(true)}
        />
      )}
      {card === undefined ? (
        <section className="card">
          {data.budget.remaining === 0 ? (
            <>
              <h2>That’s this week’s {data.budget.limit}</h2>
              <p className="muted">
                {data.budget.shownThisWeek} shown in the last seven days. More next week, or ask for more a week in
                Settings.
              </p>
            </>
          ) : (
            <>
              <h2>Nothing to ask about here right now</h2>
              <p className="muted">Set a learning goal for this project, or commit some code that touches one.</p>
            </>
          )}
        </section>
      ) : card.kind === 'candidate' && card.decision !== null ? (
        <QuestionCard
          key={card.id}
          question={card.decision}
          eyebrow={`Question ${position} of ${data.budget.limit} this week`}
          onShown={() => api.questionShown(card.id)}
          onNext={() => void loadQuestions()}
        />
      ) : (
        <OutcomeCard key={card.id} card={card} position={position} limit={data.budget.limit} onNext={() => void loadQuestions()} />
      )}
    </>
  );
}

function ConsentBanner(props: { provider: string; onAllow: () => Promise<void>; onLater: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card notice">
      <h3>Questions about your code itself need a model to read it</h3>
      <p>
        With {PROVIDER[props.provider] ?? props.provider}, the lines a question is about leave this computer and go to
        Anthropic. Until you allow it, questions here are written without reading the code. Asked once for this
        project.
      </p>
      <div className="actions">
        <button className="primary" onClick={() => void props.onAllow().catch((e: Error) => setError(e.message))}>
          Allow for this project
        </button>
        <button className="quiet" onClick={props.onLater}>
          Not now
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}

/** A question about code that touches a goal, or about a goal nothing touches yet. Answers are practice. */
function OutcomeCard(props: { card: Card; position: number; limit: number; onNext: () => void }) {
  const { card } = props;
  const [answer, setAnswer] = useState('');
  const [done, setDone] = useState<'saved' | 'pending' | 'expired' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reported = useRef(false);

  // Showing spends the budget: report it once, when the question is on screen.
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    void api.questionShown(card.id).catch((e: Error) => setError(e.message));
  }, [card.id]);

  const run = async (action: () => Promise<'saved' | 'pending' | 'expired'>) => {
    setError(null);
    try {
      setDone(await action());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const about = (n: number) => card.code !== null && n >= card.code.lines[0] && n <= card.code.lines[1];

  return (
    <section className="card">
      <p className="eyebrow">
        Question {props.position} of {props.limit} this week
        {card.outcome !== null ? ` · ${card.outcome.skill} · ${card.outcome.name}` : ''}
      </p>

      {card.code !== null ? (
        <>
          <div className="where">
            <span className={`who-badge who-${card.code.authorship}`}>
              <span className="dot" />
              written by {WHO[card.code.authorship] ?? card.code.authorship}
            </span>
            <span className="mono path">
              {card.code.path}:{card.code.lines[0]}
              {card.code.lines[1] !== card.code.lines[0] ? `–${card.code.lines[1]}` : ''}
            </span>
            <span className="muted small">@ {card.code.sha.slice(0, 7)}</span>
          </div>
          <div className="code excerpt">
            {card.code.excerpt.map((l) => (
              <div key={l.n} className={`code-line${about(l.n) ? ' hl' : ''}`}>
                <span className="ln">{l.n}</span>
                <code>{l.text === '' ? ' ' : l.text}</code>
              </div>
            ))}
          </div>
        </>
      ) : (
        card.outcome !== null && (
          <p className="muted">In your objective, and nothing in the code touches it yet: {card.outcome.description}</p>
        )
      )}

      <h3>{card.text}</h3>
      <p className="muted small">
        {card.foundBy === 'model'
          ? `Written by ${PROVIDER[card.provider ?? ''] ?? card.provider} after reading these lines.`
          : 'Written without a model reading the code. Connect one in Settings for questions about the code itself.'}
      </p>

      {done === null ? (
        <div className="form">
          <label className="field">
            <span>Explain it in your own words</span>
            <textarea rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </label>
          <p className="muted small">
            Practice: kept for you, and it doesn’t count toward learned. That takes a note on the code and a passed
            check, both coming next.
          </p>
          <div className="actions">
            <button
              className="primary"
              disabled={answer.trim() === ''}
              onClick={() =>
                void run(async () => {
                  await api.practice(card.id, answer);
                  return 'saved';
                })
              }
            >
              Save answer
            </button>
            <button className="quiet" onClick={() => void run(async () => (await api.skipQuestion(card.id)).status)}>
              Skip
            </button>
          </div>
        </div>
      ) : (
        <div className="outcome">
          <p className="ok">
            {done === 'saved'
              ? 'Saved.'
              : done === 'expired'
                ? 'Skipped three times. It won’t come up again.'
                : 'Skipped. It may come back.'}
          </p>
          <button className="primary" onClick={props.onNext}>
            Next question
          </button>
        </div>
      )}
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
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

function QuestionCard(props: {
  question: QuestionView;
  eyebrow?: string;
  /** How showing is reported; 0006's own route when not given. */
  onShown?: () => Promise<unknown>;
  onNext: () => void;
}) {
  const { question, onNext } = props;
  const [mode, setMode] = useState<Mode>({ kind: 'choosing' });
  const [error, setError] = useState<string | null>(null);
  const reported = useRef(false);

  // Showing spends the budget — report it once, when the question is on screen.
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    void (props.onShown?.() ?? api.shown(question.candidateId)).catch((e: Error) => setError(e.message));
  }, [question.candidateId, props.onShown]);

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
      <p className="eyebrow">{props.eyebrow ?? question.headline.split(' · ')[0]}</p>
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
