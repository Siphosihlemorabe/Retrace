# 0007 — Project goals and learning outcomes

**Status:** proposed — for review (2026-10-01)
**Build order:** step 3, learning goals and progression, pulled forward at the builder's request
**Writes to the database:** yes — goals, chosen outcomes, outcome sightings, commit sightings
**Guardrails:** G2, G3, G4, G8, G11, G12, G13, G14 (see [how-it-works](../how-it-works.md#guardrails))

---

## What it is

The product stops being only a look back at finished code. When a project starts, the
builder says what they want to learn from it. Each goal is broken into concrete
**learning outcomes**. As they code, every new commit is checked for which outcomes it
touches, and by whom.

```
npm run goals ../bookings-api                   (or "New project" in the web UI)

  What do you want to learn in this project?
    [x] SQL           [x] Docker           [ ] Node/REST APIs

  SQL — untick anything you don't want to work on:
    [x] Filtering and sorting        WHERE, ORDER BY, LIMIT
    [x] Joins                        INNER vs LEFT, joining on keys
    [x] Aggregates                   COUNT/SUM/AVG with GROUP BY
    [x] HAVING                       filtering groups, not rows
    [x] Indexes                      CREATE INDEX, and when it helps
    [x] Constraints                  foreign keys, UNIQUE, CHECK
    [x] Transactions                 BEGIN/COMMIT, all-or-nothing writes
    [ ] Window functions             ROW_NUMBER, running totals
    ...

  Goals saved at commit 7f2a1c0 (commit 3 of 3). From now on, new commits are checked.
```

A week later:

```
npm run coverage ../bookings-api

  SQL
    ✓ written by you     Joins          db/queries.sql:12-18   a41c09e  commit 9
    ◐ in your code       Aggregates     src/reports.ts:40      c77e1b2  commit 11 · made by your agent
    ✓ written by you     Constraints    migrations/0002.sql:4  e09d33f  commit 14
    · not yet            HAVING, Indexes, Transactions
  Docker
    ✓ written by you     Multi-stage build   Dockerfile:1-14   b3e8f10  commit 12
    · not yet            Healthcheck, Non-root user, .dockerignore, ...

  Something the detector can't see? `npm run coverage -- --add` points it at the code.
```

Every line is a pointer, (commit, file, lines), that can be followed back to the real
code. It is never a percentage or a score.

## Why this before anything else

**The builder asked for it, and it fixes the product's biggest weakness.** Questions are
thin because the only detector reads `package.json`. Outcomes give the product a reason to
look at real code, and something specific to ask about later: *that* JOIN, on *that* line.

**It's the honest version of "pre-registered".** `CLAUDE.md` says evidence is strongest
when it was written before the outcome was known. A goal declared before the code exists
is exactly that: "I said I'd learn joins at commit 3, and wrote my first one at commit 9."

**It makes the AI-assisted case honest instead of awkward.** 0003 found that the agent
writes most of this builder's code. Here that turns into the most useful distinction the
product can draw. *Written by you* and *in your code* are different statuses, and only
the first is progress on a goal.

**What choosing this costs.**
- **Hand-written outcome lists**, about ten outcomes for each of three skills, each with
  a detector. Narrow and checkable, but they bound what the product can see, the same way
  0001's package catalogue bounds recall.
- **Exposure is not learning.** A detector can prove a JOIN exists and who committed it.
  It cannot prove the builder understands it. That needs an explanation (0009). This
  feature is careful to say "written by you", never "learned".
- **The detector-driven loop (0001–0004) stops being the centre.** It keeps working, but
  goals become the main input. 0004 (inherited settings) drops in priority.

## What it is not

- **Not a curriculum or a course.** It does not teach, recommend resources, or say what
  to learn next. The builder picks the goals. (`CLAUDE.md` non-goal: no recommendations
  from market demand.)
- **No score, no percentage, no streak** (G2). "Joins ✓" links to a commit. "SQL: 60%" is
  never shown, because it invites gaming and gives a reader nothing to check.
- **Not a judgement of understanding.** That needs the builder's explanation, which comes
  with 0009.
- **No model.** Detection is rules only, so every "covered" can be checked by opening the
  file.
- **Not breadth as achievement.** More skills ticked is not better. Each goal is one
  project's intent, not a badge.

---

## How it works

### 1. Skills and outcomes

The skill taxonomy is an open question in `CLAUDE.md`. This answers it narrowly for three
skills and leaves everything else open.

| Skill (slug) | Outcomes (v1) |
|---|---|
| **SQL** (`sql`) | filtering and sorting · joins · aggregates with GROUP BY · HAVING · subqueries and CTEs · indexes · constraints (FK/UNIQUE/CHECK) · transactions · upserts (ON CONFLICT) · migrations · window functions |
| **Docker** (`docker`) | a working Dockerfile · pinned base image · multi-stage build · layer caching order · non-root user · .dockerignore · healthcheck · compose services · volumes · env and secrets · exposed ports and networking |
| **Node/REST APIs** (`node-rest-api`) | routing · status codes beyond 200 · input validation · error-handling middleware · authentication · pagination · rate limiting · CORS · structured logging · API tests |

Each outcome has a slug (`sql.joins`), a one-line description, and one or more
**detectors**: cheap pattern rules over the lines a commit *added*.

| Outcome | Detector examples |
|---|---|
| `sql.joins` | `\b(INNER\|LEFT\|RIGHT\|FULL)?\s*JOIN\b … ON` in `.sql` files and in SQL template strings; ORM calls `.innerJoin(` / `.leftJoin(` |
| `docker.multi_stage` | two or more `FROM` lines in one Dockerfile, at least one `AS name` |
| `docker.layer_caching` | `COPY package*.json` (or a lockfile) before `COPY . .`, with `RUN npm ci` between |
| `node-rest-api.validation` | a schema library (`zod`, `joi`, `yup`, `valibot`) parsing a request body inside a route handler |

**ORMs count, and are labelled.** A `.leftJoin()` in Drizzle is a join, but it is not the
same as writing SQL. Sightings record `via: 'sql' | 'orm'`, and coverage shows the
difference, so a goal of "learn SQL" can be honest about how it was met.

### 2. Declaring goals

`npm run goals <repo>`, or "New project" in the web UI. Choose skills, untick outcomes.
This writes:

- a `learning_goals` row per skill, `kind = 'intent'`, with `declared_at` (server clock)
  and `declared_at_sha` (HEAD at the time)
- a row per chosen outcome
- **a sighting of every commit that already exists** (`commit_sightings`, source
  `backfill`). That is the line between "already there" and "written after the goal".
  Outcomes found in older commits show as *already in this project*, never as progress.

Goals can be edited later, and edits are kept, the same way decision revisions are.
Unticking an outcome after it is covered is allowed and stays visible in history.

### 3. Scanning as you code

On every scan (opening the app, `npm run coverage`, and from 0008 every push), each commit
not yet sighted is:

1. sighted (`commit_sightings`, source `local_scan` here, `webhook` from 0008)
2. classified with 0003's authorship
3. diffed (`git show --unified=0`) and run through every chosen outcome's detectors, over
   **added lines only**
4. recorded as an **outcome sighting**: outcome, commit, file, line range, authorship,
   `via`, detector version. A pointer, never the code (G11).

Cost: one `git show` per new commit. Scans are incremental, so spend scales with commits
made, not repo size (`CLAUDE.md`, cost discipline).

### 4. Coverage

Per goal, per outcome, the strongest status any sighting supports:

| Status | Means | Counts as progress on the goal? |
|---|---|---|
| **written by you** | sighted in a commit after the goal was declared, authorship `builder` or `builder_with_agent` | yes |
| **in your code** | sighted after the goal, but committed by the agent (or someone else) | no, but it's the best thing to ask about (0009) |
| **already in this project** | sighted only in commits from before the goal | no |
| **not yet** | no sighting | — |
| **explained** | *(0009)* written by you, and the builder has answered a question about it | the strongest status |

`builder_with_agent` counts as written by you, because the builder authored the commit,
but it is labelled "with Claude" and the like. The same honesty rule as 0003 applies.

### 5. When the detector misses something

`--add` (and a button in the UI) lets the builder point at a commit and file and say
"this covers joins". That records a sighting with `source = 'manual'`. It is shown as
*you said so*, a claim, and never upgraded to "written by you" (G9's spirit: claims look
thinner).

---

## Decision: where the outcome catalogue lives

1. **In code, synced to a table** *(recommended)*. `src/core/outcomes/catalog/{sql,docker,
   node-rest-api}.ts` holds outcomes and their detectors together, so a detector change
   and its outcome are one diff. On start, the catalogue upserts into `skills` /
   `skill_outcomes` so goals and sightings can reference outcomes by foreign key.
   `OUTCOMES_VERSION` bumps when a detector changes what it matches (G13).
2. **Rows only.** Outcomes as data, detectors as stored regexes. Editable without a
   deploy, but regexes in a database are untestable and drift from the code that runs
   them.
3. **Generated by a model per skill.** Fast to grow to any skill, but unverified. The
   product would then be grading the builder against a list nobody checked.

## Decision: are sightings "evidence"?

1. **A separate `outcome_sightings` table** *(recommended)*. Sightings are machine
   judgements (versioned, recomputable). `evidence` stays for things a profile may one
   day show as proof. Nothing in coverage becomes `evidence` in this feature or in 0009:
   explanations are coached practice, so promotion waits for an assessed mode (0009, open
   question 2). That keeps "the agent wrote a JOIN" from ever looking like evidence of
   skill (G3, G4).
2. **Reuse `evidence` directly**, with `kind = 'outcome_sighting'`. One table fewer, but
   every query over evidence then has to remember to exclude agent-written sightings, and
   one that forgets overstates the builder.

---

## Deliverables

**Schema** — new migration
- [ ] `skill_outcomes` (skill, slug, name, description, ordinal); seed `sql`, `docker`,
      `node-rest-api` skills and aliases (`postgres`, `postgresql` → `sql`, and so on)
- [ ] `learning_goals`: `kind` in (`gap`, `intent`), `repo_id`, `declared_at_sha`;
      `learning_goal_outcomes` (goal, outcome, chosen, with history)
- [ ] `outcome_sightings` (outcome, repo, sha, path, lines, authorship, via, source in
      (`detector`, `manual`), detector version, seen at)
- [ ] `commit_sightings.source` gains `local_scan`

**Catalogue** — `src/core/outcomes/`
- [ ] Outcomes and detectors for the three skills, each detector with a positive and a
      negative fixture
- [ ] Sync into `skills` / `skill_outcomes`; `OUTCOMES_VERSION`

**Scanning** — `src/core/outcomes/scan.ts`
- [ ] Unsighted commits → sight, classify authorship, diff added lines, run detectors,
      record sightings. Incremental and idempotent
- [ ] SQL found in `.sql` files and in template strings (`sql\``, `query("…")`), and ORM calls
      marked `via: 'orm'`

**Goals and coverage** — `src/core/outcomes/goals.ts`, `coverage.ts`
- [ ] Declare goals (with the backfill sighting), edit goals with history
- [ ] Coverage per goal and outcome, with the status table above, pure over sightings

**CLI and web**
- [ ] `npm run goals <repo>`, `npm run coverage <repo>` (with `--add`)
- [ ] Web: "New project" (skills and outcomes) and a Coverage tab, every line linking to its
      commit and file

**Tests**
- [ ] Each detector against fixtures: a real multi-stage Dockerfile, a LEFT JOIN in a
      template string, a Drizzle `.leftJoin()` marked `orm`, and false positives that must
      *not* match (the word "join" in a comment, `Array.prototype.join`)
- [ ] A fixture repo: goals declared at commit 3, a builder JOIN at commit 5, an agent
      GROUP BY at commit 6, and a JOIN already present at commit 1. Each lands in the
      right status
- [ ] Copy check: coverage output has no percentage or score (G2)

**Not deliverables, on purpose:** any model, questions about outcomes (0009), GitHub
(0008), skills beyond the three, resource recommendations, scores.

---

## How we will know it worked

- **The builder sets goals on a real new project** and keeps coding normally. After two
  weeks, coverage reflects what they actually did, and they agree with each line.
- **Detector precision on outcomes:** of the sightings shown, at least 9 in 10 are real
  instances of the outcome. This bar is higher than 0001's because coverage claims are
  shown as fact.
- **The agent distinction holds up.** On a Lovable project, most sightings should be
  *in your code*, not *written by you*. If the builder disagrees, that is a 0003
  calibration finding, not a coverage one.

**Honest risk:** in a heavily agent-written project, coverage may say "in your code" for
almost everything and "written by you" for almost nothing. That is true, and useful. It
is also discouraging, and the copy has to stay on the right side of G5: it is a list of
what to ask about, not a verdict.

---

## Open questions

1. **What counts for a new, empty repo?** Declaring goals before the first commit is the
   cleanest case. Should `goals` be able to `git init` a project, or only point at one?
2. **Per project or per person?** v1 is per project. "I've written joins in three
   projects" is progression (build step 3 proper) and needs goals across repos.
3. **Outcome depth.** "Joins" covered by one INNER JOIN is shallow. Variants (LEFT, self-join,
   anti-join) could be sub-outcomes later; the slug scheme (`sql.joins.left`) leaves room.

## What this unblocks

[0009](./0009-model-questions.md): detailed questions about specific covered (or
agent-written) outcomes. [0008](./0008-github-app.md): sightings on every push, not just
when the builder opens the app.
