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
import { IdentityStep, type Identity } from './Ask.js';

type Goal = CoverageResponse['goals'][number];
type Outcome = Goal['outcomes'][number];
type Sighting = Outcome['sightings'][number];

const WHO: Record<string, string> = {
  builder: 'you',
  builder_with_agent: 'you, with an agent',
  agent: 'your agent',
  template: 'template',
  automation: 'automated',
  other_human: 'someone else',
  unknown: 'author not confirmed',
};
const SHORT: Record<string, string> = {
  builder: 'you',
  builder_with_agent: 'you+AI',
  agent: 'agent',
  template: 'tmpl',
  automation: 'bot',
  other_human: 'other',
  unknown: '?',
};
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
        <button onClick={() => setEditing(true)}>Edit goals</button>
      </div>
      {data.goals.map((g) => (
        <GoalCard key={g.goalId} repoId={repoId} goal={g} positions={data.positions} onRelabelled={() => void load()} />
      ))}
    </>
  );
}

function GoalCard(props: { repoId: string; goal: Goal; positions: Record<string, number>; onRelabelled: () => void }) {
  const { repoId, goal, positions } = props;
  const [open, setOpen] = useState(true);
  // The code view opens right under the row it belongs to.
  const [viewing, setViewing] = useState<{ outcome: string; sighting: Sighting } | null>(null);
  if (!goal.hasOutcomeList) {
    return (
      <section className="card">
        <h2>{goal.skill.name}</h2>
        <p className="muted">Its outcome list will be drafted for you to review (coming in 0009).</p>
      </section>
    );
  }
  const pct = goal.percentLearned ?? 0;
  return (
    <section className="card">
      <button className="link heading" onClick={() => setOpen(!open)}>
        <h2>
          {goal.skill.name}: {pct}% learned
        </h2>
      </button>
      <div className="bar" aria-label={`${pct}% learned`}>
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="small">
        {goal.learned} of {goal.total} learned · objective {goal.objective.met} of {goal.objective.total} met · touched{' '}
        {goal.touched} of {goal.total}
        {goal.touched > goal.learned && <span className="muted"> — waiting for you to document and explain them</span>}
      </p>
      {open && (
        <ul className="outcomes">
          {goal.outcomes.map((o) => {
            const best = o.sightings[0];
            return (
              <li key={o.slug} className={o.inObjective ? '' : 'off-objective'}>
                <span className={`chip ${o.status}`}>{STATUS[o.status]}</span>
                <div className="outcome-body">
                  <div>
                    <strong>{o.name}</strong> <span className="muted small">{o.description}</span>
                    {!o.inObjective && <span className="muted small"> · not in this project's objective</span>}
                  </div>
                  {best !== undefined && (
                    <div className="small">
                      {WHO[best.authorship] ?? best.authorship}
                      {best.when === 'before_goal' ? ', before the goal' : ''}
                      {best.via === 'orm' ? ' · via an ORM' : ''} ·{' '}
                      <span className="mono">
                        {best.path}:{best.lineStart}
                        {best.lineEnd !== best.lineStart ? `-${best.lineEnd}` : ''}
                      </span>{' '}
                      ·{' '}
                      {/* A snapshot sighting's SHA is where the code was seen when the goal was set,
                          not where it was written. */}
                      {best.when === 'before_goal' ? 'in the code at ' : ''}commit {positions[best.sha] ?? '?'}{' '}
                      <button className="link" onClick={() => setViewing({ outcome: o.slug, sighting: best })}>
                        view code
                      </button>
                      {o.sightings.length > 1 && <span className="muted"> · {o.sightings.length - 1} more place{o.sightings.length > 2 ? 's' : ''}</span>}
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
        </ul>
      )}
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
