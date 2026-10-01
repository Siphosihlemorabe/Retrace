# 0007 — Project goals and learning outcomes

**Status:** agreed (2026-10-01): building. Matches [product-direction.md](../product-direction.md) (§3.1–3.3, 3.6–3.7)
**Build order:** step 2, learning goals while building. First of 0007 → 0009 → 0010 → 0011 → 0012 → 0008
**Writes to the database:** yes — goals, objectives, outcome sightings, line labels, commit sightings
**Guardrails:** G2, G3, G4, G5, G8, G11, G12, G13, G14 (see [how-it-works](../how-it-works.md#guardrails))

---

## What it is

When the builder starts a project, or picks an existing one, they say what they want to
learn from it. Any skill can be a goal. Each skill is broken into **learning outcomes**,
and the outcomes they tick are their **objective** for this project. From then on, the
app finds the code that **touches** those outcomes, **highlights** it, and shows **who
wrote each line**.

```
New project → bookings-api

  What do you want to learn in this project?
    SQL  ✓     Docker  ✓     + add any skill…

  SQL — tick your objective for this project:
    [x] Filtering and sorting      WHERE, ORDER BY, LIMIT
    [x] Joins                      INNER vs LEFT, joining on keys
    [x] Aggregates                 COUNT/SUM/AVG with GROUP BY
    [ ] HAVING                     filtering groups, not rows
    [x] Indexes                    CREATE INDEX, and when it helps
    ...

  Saved at commit 7f2a1c0 (commit 3 of 3). New commits are checked from here on.
```

Later, on the Coverage tab:

```
  SQL in bookings-api        0% learned (0 of 11) · objective 0 of 4 met
                             touched: 3 of 11 — waiting for you to document and explain them

    Joins        touched · you             db/queries.sql:12-18     commit 9    [view code]
    Aggregates   touched · your agent      src/reports.ts:40-44     commit 11   [view code]
    Constraints  touched · before goal, you migrations/0001.sql:4    commit 2    [view code]
    Indexes      not touched yet
    ...
```

And the code view, which every "view code" link opens:

```
  db/queries.sql @ a41c09e                                   SQL · Joins highlighted
  you        10  -- bookings for the dashboard
  you        11  SELECT b.id, b.starts_at, c.name
  you      ▌ 12  FROM bookings b
  you      ▌ 13  LEFT JOIN customers c ON c.id = b.customer_id
  agent    ▌ 14  WHERE b.starts_at >= $1                       ← relabel lines
```

**"Learned" stays at 0% in this feature, on purpose.** Learned needs documenting (0010) and
a passed check (0011). This feature builds what those attach to: goals, outcomes,
touched code, and who wrote it.

## Why this before anything else

**The builder decided the product is used while building** (product-direction §1). Goals
and outcomes are what every later step (questions, documenting, checks, percentages, the
profile) attaches to.

**It fixes why questions are thin.** The only detector reads `package.json`. Outcomes give
the product a reason to look at real code, and *specific lines* to ask about in 0009.

**It makes the AI-assisted case precise.** Per-line authorship separates *your agent wrote
this* from *you wrote this*. Both get asked about, and neither is credited until it's
understood (CLAUDE.md, "code being present is not learning").

**What choosing this costs.**
- **Hand-written outcome lists and detectors** for SQL, Docker and Node/REST. They bound
  what the rules can see, as 0001's catalogue bounds its recall.
- **Other skills have to wait for 0009.** They can be set as goals here, but their outcome
  list is drafted by a model, which arrives in 0009. Until then they show "outcome list
  coming".
- **`git blame` per highlighted file**, which gets slower on large files. It runs only on
  files with sightings, and is cached per commit.

## What it is not

- **Not "learned".** Only documented (0010) and checked (0011) outcomes are learned.
- **Not a course.** It doesn't teach or recommend what to learn. The builder chooses
  (CLAUDE.md non-goal).
- **No overall score for the person** (G2). Percentages are per goal, per project only.
- **No guessing who wrote code from how it looks.** Authorship comes from commit history,
  plus the builder's own relabels (product-direction §3.3).
- **No model.** Rules only, for the three built-in skills. Model-drafted lists and
  model-found coverage are 0009.
- **No GitHub.** Scans happen when the app is opened or `npm run coverage` runs. Push-time
  scans are 0008.

---

## How it works

### 1. Skills, outcomes, objectives

- **Skill:** anything the builder names. Built-in, with an outcome list and detectors:
  `sql`, `docker`, `node-rest-api`. Any other name is stored as a skill with no list yet.
- **Outcome:** a concrete thing to learn within a skill (`sql.joins`), with a one-line
  description.
- **Objective:** the outcomes the builder ticks for *this project*. It's **met** when every
  ticked outcome is learned (from 0011).
- **The percentage's denominator is always the full list**, ticked or not, so unticking
  hard outcomes cannot inflate progress (product-direction §3.7).

| Skill | Outcomes (v1, hand-written) |
|---|---|
| **SQL** | filtering and sorting · joins · aggregates with GROUP BY · HAVING · subqueries and CTEs · indexes · constraints (FK/UNIQUE/CHECK) · transactions · upserts (ON CONFLICT) · migrations · window functions |
| **Docker** | a working Dockerfile · pinned base image · multi-stage build · layer caching order · non-root user · .dockerignore · healthcheck · compose services · volumes · env and secrets · ports and networking |
| **Node/REST APIs** | routing · status codes beyond 200 · input validation · error-handling middleware · authentication · pagination · rate limiting · CORS · structured logging · API tests |

**Detectors** are rules over the lines a commit *added*, for example:

| Outcome | Rule |
|---|---|
| `sql.joins` | `JOIN … ON` in `.sql` files and in SQL template strings; ORM `.innerJoin(` / `.leftJoin(` |
| `docker.multi_stage` | two or more `FROM` lines in one Dockerfile, at least one `AS name` |
| `docker.layer_caching` | a lockfile `COPY` before `COPY . .`, with an install step between |
| `node-rest-api.validation` | a schema library parsing a request body inside a route handler |

**ORMs count as touching** (builder's decision), and are labelled `via: orm` so the
difference stays visible.

### 2. Setting goals — new and existing projects

`npm run goals <repo>`, or "New project" in the web UI. Both new and existing projects
work. Setting goals:

- writes a goal per skill (`declared_at` on the server clock, `declared_at_sha`), and the
  ticked outcomes as the objective
- sights every existing commit (`commit_sightings`, source `backfill`), marking the line
  between *before the goal* and *after*
- scans that existing history once, so outcomes already in the project show as **touched
  before goal**

**Code written before the goal can still be learned** once it's documented and explained
(builder's decision). It's labelled "before goal", which is the honest record.

Goals and objectives can be edited, and every edit is kept.

### 3. Scanning

On every scan (opening the app, `npm run coverage`), each commit not yet sighted is:

1. sighted (source `local_scan`)
2. given an authorship (0003)
3. diffed with `git show --unified=0`, and the added lines run through each goal's
   detectors
4. recorded as an **outcome sighting**: outcome, commit, file, line range, `via`, `found_by:
   rule`, detector version. A pointer only, never the code (G11)

It's incremental, so cost scales with commits made, not repo size.

### 4. Who wrote each line

For a highlighted range, `git blame` at the scanned commit gives the commit behind each
line, and that commit's authorship (0003) labels the line:

| Label | From |
|---|---|
| **you** | your identity |
| **you, with an agent** | your identity, plus an AI co-author trailer |
| **your agent** | a known agent identity (for example the Lovable bot) |
| **template** | the root or template commit |
| **someone else** | an identity you said isn't you |

**Relabelling:** the builder can select lines and say "an AI wrote this" or "I wrote this".
The relabel is stored with the line range and commit, shown as "you said", and overrides
the label for those lines. Nothing is ever guessed from code style.

### 5. Coverage and percentages

Per goal, per outcome, the strongest status reached:

| Status | Means |
|---|---|
| **not touched** | no sighting |
| **touched** | a sighting exists. Shows who wrote it, before or after the goal, `via` and `found_by` |
| **documented** | *(0010)* a note in the builder's words on the touched lines |
| **learned** | *(0011)* documented, and a check passed |

- **Percentage** = learned ÷ the skill's full outcome list, shown with the count ("36% learned,
  4 of 11"), and with touched-but-not-learned alongside it.
- **Objective** = ticked outcomes learned ÷ ticked outcomes ("objective 3 of 4 met").
- **Both are clickable** to the list, and every item to its code view (product-direction §3.7).

---

## Decision: where the outcome catalogue lives — **chosen: 1** (builder, 2026-10-01)

1. **In code, synced to a table** *(recommended)*. Outcomes and detectors live together in
   `src/core/outcomes/catalog/`, so a detector change and its outcome are one diff. They are
   upserted into `skill_outcomes` on start, so goals and sightings can reference them.
   `OUTCOMES_VERSION` bumps when a detector changes what it matches.
2. **Rows only**, with detectors as stored regexes. Editable without a release, but
   untestable, and they drift from the code that runs them.

## Decision: where sightings live — **chosen: 1** (builder, 2026-10-01)

1. **Their own `outcome_sightings` table** *(recommended)*. Sightings are machine
   judgements (versioned, recomputable), and `evidence` stays for what the profile shows
   as proof. Agent-written sightings can then never be mistaken for evidence.
2. **Reuse `evidence`.** One table fewer, but every query must remember to exclude agent
   sightings, and one that forgets overstates the builder.

---

## Deliverables

**Schema** — new migration
- [x] `skill_outcomes` (skill, slug, name, description, ordinal), with the three built-in
      skills and their aliases (`postgres`, `postgresql` → `sql`, and so on)
- [x] `learning_goals`: `kind` in (`gap`, `intent`), `repo_id`, `declared_at_sha`;
      `learning_goal_outcomes` (goal, outcome, in objective), with edit history
- [x] `outcome_sightings` (outcome, repo, sha, path, lines, via, found by `rule`|`model`,
      detector version, seen at)
- [x] `line_labels` (repo, path, sha, lines, label `agent`|`me`, created at): the builder's
      relabels
- [x] `commit_sightings.source` gains `local_scan`

**Outcomes** — `src/core/outcomes/`
- [x] Catalogue for SQL, Docker and Node/REST (32 outcomes), each detector with a positive
      and a negative fixture; `OUTCOMES_VERSION`
- [x] Sync the catalogue to tables
- [x] Scan: unsighted commits → sight, authorship, added lines, detectors, sightings
- [x] Line authorship: `git blame` on highlighted ranges, cached per commit, relabels applied
- [x] Goals: declare (with backfill and a first scan), edit with history; other skills saved
      without a list
- [x] Coverage: statuses, percentage (full-list denominator), objective; pure over stored rows

**CLI and web**
- [x] `npm run goals <repo>`, `npm run coverage <repo>`
- [x] "New project" can create the folder (`git init`, an empty first commit) and,
      if the builder confirms and `gh` is available, the GitHub repo
- [ ] Web: "New project" (any skill, tick the objective), a Coverage tab (percentages and
      the outcome list), and a code view (highlighted ranges, an authorship gutter,
      relabel by selecting lines)

**Tests**
- [ ] Detectors against fixtures, including false positives that must not match
      (`Array.prototype.join`, "join" in a comment)
- [x] Fixture repo: commit 1 (agent, has a JOIN), goal set at commit 2, a builder JOIN at 3,
      an agent GROUP BY at 4, a Claude-trailer commit at 5. Each sighting gets the right
      author and before/after label
- [x] Unticking an outcome never changes the percentage's denominator
- [x] A relabel overrides blame for exactly those lines
- [ ] Copy checks: no overall score; "learned" never appears for undocumented or unchecked
      outcomes

**Not deliverables, on purpose:** documenting (0010), checks (0011), model lists and coverage
(0009), the profile (0012), GitHub (0008), guessing authorship from code style.

---

## How we will know it worked

- **The builder sets goals on one new and one existing project,** codes normally for two
  weeks, and agrees with every touched line shown.
- **Detector precision:** at least 9 in 10 sightings are real instances of their outcome.
- **Authorship holds up:** on a Lovable project, relabels stay rare. Many relabels mean
  commit history misattributes work, which is a 0003 finding.

**Honest risk:** on an agent-heavy project, nearly every touched line will say "your agent",
and "learned" stays at 0% until 0010 and 0011 land. That's accurate, and it's the
motivation the builder asked for ("make the dev know they still need to improve"). But it
must read as *what to work on next*, never as a verdict (G5).

---

## Build notes

- **Detectors see the whole file but only credit added lines.** A detector reads the file as
  it is at the commit, because multi-stage builds and layer order are properties of the
  whole Dockerfile. A hit only counts for a commit if it includes a line that commit added,
  so old code is never credited to a new commit.
- **SQL inside JS/TS only counts inside SQL-looking strings and templates.** That is what
  keeps `Array.prototype.join` and the word "join" in a comment from ever counting.
- **The first real-repo run found three noisy rules the fixtures had missed.** Each fix now
  has a regression fixture:
  - A Drizzle `check('name', sql`…`)` rule matched a test helper, `check("POST status →
    401", …)`: 78 false constraints in `confetti-confectionery`. It now requires the name
    and an `sql` template.
  - Input validation fired on a React form's `z.object` (`frontend-fixer` `Login.tsx`). It
    now requires parsing *request* input.
  - `WITH CHECK (…)` row-level-security policies counted as constraints. They are excluded.
- **What the snapshot found after the fixes:** `confetti`: constraints, migrations,
  transactions, upserts and filtering, all SQL from its Supabase migrations and client.
  `Konnect`: nine Docker outcomes from its Python Dockerfile, and SQL from its
  migrations. `frontend-fixer`: nothing, which is correct for a frontend-only repo.

- **"Already in the project" is a snapshot of HEAD, not a walk of history.** When a goal is
  set, the code as it is at that moment is scanned once, and each hit is attributed line by
  line with blame. Walking every past commit would also credit code that has since been
  deleted, and takes minutes on a long history. Setting SQL and Docker goals on
  `confetti-confectionery` (59 commits) took about 14 seconds.
- **A relabel applies at the commit it was made on.** "An AI wrote this" is stored with
  the exact (commit, file, lines), and re-attributes the sightings it overlaps there. It
  does not follow those lines into later commits yet. Following them would mean tracking
  each line back to its original commit, which is a later refinement if relabels turn out
  to be common.
- **Imported repos show their first commit as "template".** `confetti`'s root is a wholesale
  import of existing code ("joins the company pipeline"), and 0003 classifies every root
  commit as a template. Its lines therefore read as template, not as the builder's. This is
  0001's open question 1b, now visible in coverage. Until it's decided, a relabel ("I wrote
  this") is the fix.
- **A custom skill's `kind` is stored as "technology"**, because `skills.kind` is required and
  the taxonomy question in `CLAUDE.md` is still open.

## Open questions

1. ~~Starting from an empty folder?~~ **Decided (builder, 2026-10-01):** "New project"
   always creates a local folder, runs `git init`, and makes an empty first commit, so goals
   are saved before any code exists. Optionally, and asked each time, it also creates the
   repo on GitHub and connects it, only when GitHub's `gh` tool is installed and logged in.
   That is outward-facing, so it is never done without the builder confirming.
2. **Depth within an outcome** (LEFT versus self-join versus anti-join): sub-outcomes later,
   and the slug scheme (`sql.joins.left`) leaves room.

## What this unblocks

0009 (questions about touched lines, and lists for any skill), 0010 (documenting touched
lines), 0011 (checks that turn documented into learned), 0012 (the profile).
