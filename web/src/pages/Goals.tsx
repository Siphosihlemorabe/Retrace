/**
 * Goals and coverage (0007): what you want to learn in this project, what your
 * code touches of it, who wrote that code, and how much is learned.
 *
 * Learned needs documenting (0010) and a passed check (0011), so it reads 0%
 * until those exist. The percentage is out of the skill's full list and is
 * always clickable through to the evidence (product-direction §3.7).
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type CodeViewResponse, type CoverageResponse, type RepoView, type SkillView } from '../api.js';
import { SHORT, WHO } from '../labels.js';
import { IdentityStep, type Identity } from './Ask.js';

type Goal = CoverageResponse['goals'][number];
type Outcome = Goal['outcomes'][number];
type Sighting = Outcome['sightings'][number];

const STATUS: Record<Outcome['status'], string> = {
  learned: 'learned',
  documented: 'documented',
  touched: 'touched',
  not_touched: 'not yet',
};

export function GoalsPage(props: { repos: RepoView[]; repoId: string | null; onPick: (id: string) => void; onAddRepo: () => void }) {
  const { repos, repoId, onPick, onAddRepo } = props;
  if (repos.length === 0) {
    return (
      <section className="card">
        <h2>No projects yet</h2>
        <p>Start a new project, or add one you already have.</p>
        <button className="primary" onClick={onAddRepo}>
          Add a project
        </button>
      </section>
    );
  }
  return (
    <>
      <div className="toolbar">
        <label>
          Project{' '}
          <select value={repoId ?? ''} onChange={(e) => onPick(e.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {repoId !== null && <Coverage key={repoId} repoId={repoId} />}
    </>
  );
}

function Coverage({ repoId }: { repoId: string }) {
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const scan = await api.scan(repoId);
      setChecked(scan.commits);
      setData(await api.coverage(repoId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [repoId]);

  // Who wrote what depends on knowing which identities are yours: ask first.
  useEffect(() => {
    void api.identities(repoId).then(
      ({ unresolved }) => {
        setIdentities(unresolved);
        if (unresolved.length === 0) void load();
      },
      (e: Error) => setError(e.message),
    );
  }, [repoId, load]);

  if (error !== null) return <p className="error">{error}</p>;
  if (identities !== null && identities.length > 0) {
    return (
      <IdentityStep
        identity={identities[0] as Identity}
        remaining={identities.length}
        onDone={() => {
          const rest = identities.slice(1);
          setIdentities(rest);
          if (rest.length === 0) void load();
        }}
      />
    );
  }
  if (data === null) return <p className="muted">Checking new commits…</p>;

  if (editing || data.goals.length === 0) {
    return (
      <GoalsEditor
        repoId={repoId}
        existing={data.goals}
        onCancel={data.goals.length === 0 ? null : () => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await load();
        }}
      />
    );
  }

  return (
    <>
      <div className="actions spread">
        <span className="muted small">
          {checked !== null && checked > 0 ? `Checked ${checked} new commit${checked === 1 ? '' : 's'}. ` : ''}
          {data.commitCount} commits in this project.
        </span>
        <button className="btn-secondary" onClick={() => setEditing(true)}>
          Edit goals
        </button>
      </div>
      {data.goals.map((g) => (
        <GoalCard key={g.goalId} repoId={repoId} goal={g} positions={data.positions} onRelabelled={() => void load()} />
      ))}
    </>
  );
}

/** Learned (solid) and touched (faint) as one ring, so "still to do" is visible at a glance. */
function Ring({ learned, touched, total }: { learned: number; touched: number; total: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const frac = (n: number) => (total === 0 ? 0 : n / total);
  const pct = Math.round(frac(learned) * 100);
  return (
    <svg className="ring" viewBox="0 0 84 84" role="img" aria-label={`${pct}% learned`}>
      <circle cx="42" cy="42" r={r} className="ring-track" />
      {/* A zero-length round-capped stroke still draws a dot, so empty arcs are not drawn. */}
      {touched > 0 && <circle
        cx="42"
        cy="42"
        r={r}
        className="ring-touched"
        strokeDasharray={`${frac(touched) * c} ${c}`}
        transform="rotate(-90 42 42)"
      />}
      {learned > 0 && <circle
        cx="42"
        cy="42"
        r={r}
        className="ring-learned"
        strokeDasharray={`${frac(learned) * c} ${c}`}
        transform="rotate(-90 42 42)"
      />}
      <text x="42" y="40" className="ring-pct">
        {pct}%
      </text>
      <text x="42" y="55" className="ring-label">
        learned
      </text>
    </svg>
  );
}

type Filter = 'all' | 'objective' | 'todo';

function GoalCard(props: { repoId: string; goal: Goal; positions: Record<string, number>; onRelabelled: () => void }) {
  const { repoId, goal, positions } = props;
  const [filter, setFilter] = useState<Filter>('all');
  // The code view opens right under the row it belongs to.
  const [viewing, setViewing] = useState<{ outcome: string; sighting: Sighting } | null>(null);

  if (!goal.hasOutcomeList) {
    return (
      <section className="card goal-card">
        <div className="goal-head">
          <div className="skill-icon">{goal.skill.name.slice(0, 2)}</div>
          <div>
            <div className="goal-title">
              <h2>{goal.skill.name}</h2>
              <StopGoal repoId={repoId} goal={goal} onStopped={props.onRelabelled} />
            </div>
            <p className="muted">There is no built-in list of what {goal.skill.name} breaks into. Draft one and review it.</p>
          </div>
        </div>
        <OutcomeListReview skill={goal.skill} onSaved={props.onRelabelled} />
      </section>
    );
  }

  const shown = goal.outcomes.filter((o) =>
    filter === 'objective' ? o.inObjective : filter === 'todo' ? o.status !== 'learned' && o.inObjective : true,
  );

  return (
    <section className="card goal-card">
      <div className="goal-head">
        <Ring learned={goal.learned} touched={goal.touched} total={goal.total} />
        <div className="goal-summary">
          <div className="goal-title">
            <h2>{goal.skill.name}</h2>
            <span className="muted small">out of {goal.total} outcome{goal.total === 1 ? '' : 's'}</span>
            <StopGoal repoId={repoId} goal={goal} onStopped={props.onRelabelled} />
          </div>
          <div className="stats">
            <div className="stat">
              <span className="stat-value">
                {goal.learned}
                <span className="stat-of">/{goal.total}</span>
              </span>
              <span className="stat-label">learned</span>
            </div>
            <div className="stat">
              <span className="stat-value">
                {goal.objective.met}
                <span className="stat-of">/{goal.objective.total}</span>
              </span>
              <span className="stat-label">objective met</span>
            </div>
            <div className="stat">
              <span className="stat-value">
                {goal.touched}
                <span className="stat-of">/{goal.total}</span>
              </span>
              <span className="stat-label">touched in code</span>
            </div>
          </div>
          {goal.touched > goal.learned && (
            <p className="hint">
              {goal.touched - goal.learned} touched outcome{goal.touched - goal.learned === 1 ? '' : 's'} waiting for you
              to document and explain {goal.touched - goal.learned === 1 ? 'it' : 'them'}.
            </p>
          )}
          {goal.modelList && <ModelScan repoId={repoId} skill={goal.skill.slug} onFound={props.onRelabelled} />}
        </div>
      </div>

      <div className="segmented small-seg" role="tablist" aria-label="Show outcomes">
        {(
          [
            ['all', 'All'],
            ['objective', 'My objective'],
            ['todo', 'Still to learn'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'seg active' : 'seg'} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>

      <ul className="outcomes">
        {shown.map((o) => {
          const best = o.sightings[0];
          return (
            <li key={o.slug} className={`outcome-row${o.inObjective ? '' : ' off-objective'}`}>
              <span className={`pill status-${o.status}`}>{STATUS[o.status]}</span>
              <div className="outcome-body">
                <div className="outcome-name">
                  <strong>{o.name}</strong>
                  <span className="muted small">{o.description}</span>
                  {!o.inObjective && <span className="tag">not in objective</span>}
                </div>
                {best !== undefined && (
                  <div className="where">
                    <span className={`who-badge who-${best.authorship}`}>
                      <span className="dot" />
                      {WHO[best.authorship] ?? best.authorship}
                    </span>
                    {best.when === 'before_goal' && <span className="tag">before the goal</span>}
                    {best.foundBy === 'model' && <span className="tag">found by the model</span>}
                    {best.via === 'orm' && <span className="tag">via an ORM</span>}
                    <span className="mono path">
                      {best.path}:{best.lineStart}
                      {best.lineEnd !== best.lineStart ? `–${best.lineEnd}` : ''}
                    </span>
                    <span className="muted small">
                      {/* A snapshot sighting's SHA is where the code was seen when the goal was set,
                          not where it was written. */}
                      {best.when === 'before_goal' ? 'in the code at ' : ''}commit {positions[best.sha] ?? '?'}
                      {o.sightings.length > 1 && ` · +${o.sightings.length - 1} more`}
                    </span>
                    <button
                      className="btn-ghost small-btn"
                      onClick={() => setViewing(viewing?.outcome === o.slug ? null : { outcome: o.slug, sighting: best })}
                    >
                      {viewing?.outcome === o.slug ? 'Hide code' : 'View code'}
                    </button>
                  </div>
                )}
                {viewing?.outcome === o.slug && (
                  <CodeView
                    repoId={repoId}
                    sha={viewing.sighting.sha}
                    path={viewing.sighting.path}
                    focus={[viewing.sighting.lineStart, viewing.sighting.lineEnd]}
                    onClose={() => setViewing(null)}
                    onRelabelled={props.onRelabelled}
                  />
                )}
              </div>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="empty-row muted">
            {filter === 'todo' ? 'Everything in your objective is learned.' : 'No outcomes in your objective yet. Edit goals to tick some.'}
          </li>
        )}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

function GoalsEditor(props: { repoId: string; existing: Goal[]; onCancel: (() => void) | null; onSaved: () => Promise<void> }) {
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.skills().then(({ skills }) => {
      setSkills(skills);
      // Existing goals start with their current objective ticked.
      const start: Record<string, Set<string>> = {};
      for (const g of props.existing) {
        if (g.hasOutcomeList) start[g.skill.slug] = new Set(g.outcomes.filter((o) => o.inObjective).map((o) => o.slug));
      }
      setPicked(start);
    }, (e: Error) => setError(e.message));
  }, [props.existing]);

  const toggleSkill = (s: SkillView) =>
    setPicked((p) => {
      const next = { ...p };
      if (next[s.slug] !== undefined) delete next[s.slug];
      else next[s.slug] = new Set(s.outcomes.map((o) => o.slug));
      return next;
    });
  const toggleOutcome = (skill: string, slug: string) =>
    setPicked((p) => {
      const set = new Set(p[skill]);
      if (set.has(slug)) set.delete(slug);
      else set.add(slug);
      return { ...p, [skill]: set };
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const goals = [
        ...Object.entries(picked).map(([slug, set]) => ({ name: slug, objective: [...set] })),
        ...other
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
          .map((name) => ({ name, objective: 'all' as const })),
      ];
      if (goals.length === 0) throw new Error('Pick at least one skill.');
      await api.setGoals(props.repoId, goals);
      await props.onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (skills === null) return <p className="muted">Loading…</p>;
  return (
    <section className="card">
      <h2>What do you want to learn in this project?</h2>
      <p className="muted small">
        Tick a skill, then untick anything that isn't part of this project's objective. Your percentage is always out
        of the skill's full list.
      </p>
      {skills.map((s) => {
        const set = picked[s.slug];
        return (
          <div key={s.slug} className="skill">
            <label className="check">
              <input type="checkbox" checked={set !== undefined} onChange={() => toggleSkill(s)} /> <strong>{s.name}</strong>
            </label>
            {set !== undefined && (
              <ul className="ticks">
                {s.outcomes.map((o) => (
                  <li key={o.slug}>
                    <label className="check">
                      <input type="checkbox" checked={set.has(o.slug)} onChange={() => toggleOutcome(s.slug, o.slug)} /> {o.name}{' '}
                      <span className="muted small">{o.description}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <label className="field">
        <span>Any other skill</span>
        <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="e.g. Redis, GraphQL (comma-separated)" />
      </label>
      <p className="muted small">Other skills get an outcome list drafted for you to review (coming in 0009).</p>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Reading the project…' : 'Save goals'}
        </button>
        {props.onCancel !== null && (
          <button className="quiet" onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------

/** Two clicks, no browser dialog. Nothing is deleted, and the copy says so. */
function StopGoal(props: { repoId: string; goal: Goal; onStopped: () => void }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!asking) {
    return (
      <button className="btn-ghost small-btn push-right" onClick={() => setAsking(true)}>
        Stop tracking
      </button>
    );
  }
  return (
    <span className="actions push-right">
      <span className="muted small">Stop tracking {props.goal.skill.name} here? Its history is kept; add it again to bring it back.</span>
      <button
        className="small-btn"
        onClick={() => void api.stopGoal(props.repoId, props.goal.goalId).then(props.onStopped, (e: Error) => setError(e.message))}
      >
        Stop
      </button>
      <button className="quiet small-btn" onClick={() => setAsking(false)}>
        Keep
      </button>
      {error !== null && <span className="error small">{error}</span>}
    </span>
  );
}

// --- 0009: outcome lists for any skill ----------------------------------------

type Row = { name: string; description: string; cues: string };
const BLANK: Row = { name: '', description: '', cues: '' };
const cuesOf = (row: Row) =>
  row.cues
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
const rowOk = (row: Row) => row.name.trim().length >= 2 && row.description.trim().length >= 5 && cuesOf(row).length > 0;

/** Draft, edit, save. Nothing is used until the builder saves it. */
function OutcomeListReview(props: { skill: { slug: string; name: string }; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.draftOutcomes(props.skill.slug);
      if (r.outcomes === null) setError(r.message ?? 'No model could draft a list.');
      else setRows(r.outcomes.map((o) => ({ name: o.name, description: o.description, cues: o.lookFor.join(', ') })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (rows === null) return;
    setError(null);
    try {
      await api.saveOutcomes(
        props.skill.slug,
        rows.map((r) => ({ name: r.name.trim(), description: r.description.trim(), lookFor: cuesOf(r) })),
      );
      props.onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const edit = (i: number, patch: Partial<Row>) => setRows((rs) => rs?.map((r, j) => (j === i ? { ...r, ...patch } : r)) ?? null);

  if (rows === null) {
    return (
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => void draft()}>
          {busy ? 'Drafting…' : 'Draft a list with the model'}
        </button>
        <button onClick={() => setRows([{ ...BLANK }])}>Write my own</button>
        {error !== null && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="review">
      <p className="muted small">
        Edit anything, remove what doesn’t belong, add what’s missing. “Look for” is text that appears in code when
        the outcome is touched, separated by commas. Only files containing it are read by the model.
      </p>
      <ul className="review-list">
        {rows.map((r, i) => (
          <li key={i} className="review-row">
            <input aria-label="Outcome" placeholder="Outcome" value={r.name} onChange={(e) => edit(i, { name: e.target.value })} />
            <input
              aria-label="What doing it well looks like"
              placeholder="What doing it well looks like"
              value={r.description}
              onChange={(e) => edit(i, { description: e.target.value })}
            />
            <input
              aria-label="Look for in code"
              className="mono"
              placeholder="look for, in, code"
              value={r.cues}
              onChange={(e) => edit(i, { cues: e.target.value })}
            />
            <button className="quiet" aria-label={`Remove ${r.name || 'this outcome'}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button onClick={() => setRows([...rows, { ...BLANK }])}>Add an outcome</button>
        <button className="primary" disabled={rows.length === 0 || !rows.every(rowOk)} onClick={() => void save()}>
          Use this list
        </button>
        <button className="quiet" onClick={() => setRows(null)}>
          Cancel
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}

/** The model reads files the list's cues point at. Asks for consent first if code would leave the computer. */
function ModelScan(props: { repoId: string; skill: string; onFound: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false);

  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.modelScan(props.repoId, props.skill);
      if (!r.ok) {
        setNeedsConsent(r.reason === 'no_consent');
        setNote(r.message);
        return;
      }
      setNeedsConsent(false);
      setNote(
        `Read ${r.read} file${r.read === 1 ? '' : 's'}${r.cached > 0 ? ` (${r.cached} unchanged, not read again)` : ''}; found ${r.sightings} new place${r.sightings === 1 ? '' : 's'}.` +
          (r.stopped === 'run_limit' ? ' More files to read: run it again.' : r.stopped === 'capped' ? ' Today’s model calls are used up.' : ''),
      );
      if (r.sightings > 0) props.onFound();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="actions">
      <button className="btn-secondary" disabled={busy} onClick={() => void run()}>
        {busy ? 'Reading…' : 'Find code with the model'}
      </button>
      {needsConsent && (
        <button
          onClick={() =>
            void api.allowModel(props.repoId).then(
              () => void run(),
              (e: Error) => setNote(e.message),
            )
          }
        >
          Allow for this project
        </button>
      )}
      {note !== null && <span className="muted small">{note}</span>}
    </div>
  );
}

function CodeView(props: {
  repoId: string;
  sha: string;
  path: string;
  focus: [number, number];
  onClose: () => void;
  onRelabelled: () => void;
}) {
  const [view, setView] = useState<CodeViewResponse | null>(null);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.code(props.repoId, props.sha, props.path));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [props.repoId, props.sha, props.path]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.getElementById(`line-${props.focus[0]}`)?.scrollIntoView({ block: 'center' });
  }, [view, props.focus]);

  const highlighted = (n: number) => view?.highlights.some((h) => n >= h.start && n <= h.end) ?? false;
  const selected = (n: number) => sel !== null && n >= sel[0] && n <= sel[1];

  const pick = (n: number, extend: boolean) =>
    setSel((s) => (extend && s !== null ? [Math.min(s[0], n), Math.max(s[1], n)] : [n, n]));

  const relabel = async (label: 'agent' | 'me') => {
    if (sel === null) return;
    try {
      await api.label(props.repoId, { sha: props.sha, path: props.path, lineStart: sel[0], lineEnd: sel[1], label });
      setSel(null);
      await load();
      props.onRelabelled();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card code-card">
      <div className="actions spread">
        <div>
          <strong className="mono">{props.path}</strong>{' '}
          <span className="muted small">
            @ {props.sha.slice(0, 7)} {view?.position != null ? `· commit ${view.position}` : ''}
          </span>
        </div>
        <button className="quiet" onClick={props.onClose}>
          Close
        </button>
      </div>
      <p className="muted small">
        Highlighted lines touch your goals. The left column says who wrote each line, from your commit history. Click a
        line number (shift-click for a range) to correct it.
      </p>
      {sel !== null && (
        <div className="actions">
          <span className="small">
            Lines {sel[0]}
            {sel[1] !== sel[0] ? `–${sel[1]}` : ''}:
          </span>
          <button onClick={() => void relabel('me')}>I wrote these</button>
          <button onClick={() => void relabel('agent')}>An AI wrote these</button>
          <button className="quiet" onClick={() => setSel(null)}>
            Cancel
          </button>
        </div>
      )}
      {error !== null && <p className="error">{error}</p>}
      {view === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="code">
          {view.lines.map((l) => (
            <div
              key={l.n}
              id={`line-${l.n}`}
              className={`code-line${highlighted(l.n) ? ' hl' : ''}${selected(l.n) ? ' sel' : ''}`}
            >
              <span className={`who ${l.authorship}`} title={l.relabelled ? 'you said' : (l.actor ?? WHO[l.authorship] ?? '')}>
                {SHORT[l.authorship] ?? l.authorship}
                {l.relabelled ? '*' : ''}
              </span>
              <button className="ln" onClick={(e) => pick(l.n, e.shiftKey)}>
                {l.n}
              </button>
              <code>{l.text === '' ? ' ' : l.text}</code>
            </div>
          ))}
        </div>
      )}
      <p className="muted small">* = you corrected who wrote it</p>
    </section>
  );
}
