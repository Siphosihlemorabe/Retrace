# Retrace

Turns code you've already written into a record of judgement — what you chose, what it
cost, and whether you can explain it.

> **Name not settled.** "Retrace" is the working name, taken from the directory. It is a
> placeholder, not a decision.

**Status:** the detector runs — `npm run detect <repo>` finds dependency decisions in a
local clone and writes nothing. Schema and migrations exist and typecheck but have never
been applied to a database. No server, no webhooks, no capture flow yet.

---

## What it does

Most real decisions never get written down. This reads your git history, finds the
places where you made a choice that mattered, and asks you about them.

A candidate has to pass three tests to be worth asking about:

1. **There was a real alternative.** Postgres instead of SQLite is a choice. A `for` loop
   is not.
2. **It's load-bearing.** The choice shapes the schema, the failure behaviour, the deploy
   story. If nothing depends on it, it's trivia.
3. **You actually chose it.** If `create-next-app` put it there, it isn't your decision.
   This is the most important filter and the easiest one to get wrong.

Two answers, both worth having, only one of which is evidence:

- *"I chose this deliberately, here's the cost"* → a decision record.
- *"I didn't know that was a choice"* → a learning goal.

The full product reasoning — scope rules, evidence model, non-goals — lives in
[`CLAUDE.md`](./CLAUDE.md). That file is the source of truth; this one is orientation.

### The honest limit

A decision record is text, and models write excellent text about tradeoffs. The claim
this product can defend is **"harder to fake than a CV, and cheaper to check"** — not
"verified", not "proven". Keep UI copy inside that line.

---

## Stack

Every choice below is reversible in a weekend. The cost column is the point.

| Layer | Choice | What it costs |
|---|---|---|
| Runtime | Node 22 LTS | Slower dev loop than Bun. Buys a path with no surprises around `git` subprocesses, webhook crypto, and the Anthropic SDK. |
| HTTP | Hono | You hand-roll sessions, and public profiles get server-rendered by hand later. Buys: nothing hidden — the router and middleware chain are readable end to end. |
| Frontend | Vite + React, served as static assets | You own the API contract explicitly instead of getting it implicitly. |
| Database | Postgres | A running service and a network hop from day one, where SQLite would need neither. Buys: a second process can read the data without a migration. |
| DB access | Drizzle | Hand-written SQL migrations; the query builder will occasionally fight you. Buys: the SQL stays visible. |
| Validation | Zod, at boundaries only | Nothing, if kept to boundaries. Webhook payloads and LLM output are untrusted; internal function args are not. |
| Repo access | GitHub App | ~a day of App registration, JWT plumbing, and local tunnelling before the first webhook lands. Buys: `first_seen_at` is trustworthy from the moment a repo is connected. |
| LLM | `claude-opus-5` | Per-analysis cost, bounded by caching against commit SHAs. |

**Why not Next.js:** three of the four components — webhook receiver, job runner,
detector — are plain server code that Next's request model complicates, and a second
entry point would be needed anyway. Next also hides its caching and rendering semantics
by design, which is the wrong trade for a codebase built to be understood line by line.

**Why a long-running container, not serverless:** webhooks, background analysis, and
`git clone` all want a process that stays up and a disk that persists.

---

## Structure

```
.
├── CLAUDE.md               Product reasoning. Read before changing scope.
├── docs/
│   ├── decisions/          ADRs for this codebase. Dogfooding: the detector
│   │                       should eventually find these on its own.
│   └── features/           Numbered specs. Written before the feature, edited
│                           while building it, kept after.
├── migrations/             Plain SQL, applied by drizzle-kit. Never edit an
│                           applied migration.
├── src/
│   ├── server/             Entry point: HTTP. Webhook receiver, API, static assets.
│   │   ├── routes/         One file per resource. Thin — parse, authorise, delegate.
│   │   └── middleware/     Session, webhook signature verification, request logging.
│   ├── worker/             Entry point: drains the jobs table. Same process as
│   │                       `server` in dev; split out when it hurts.
│   ├── cli/                Entry point: runs the detector against a local clone and
│   │                       prints candidates. Writes nothing. This is the fast
│   │                       feedback loop while the detector is being tuned.
│   ├── core/               Everything reusable. No HTTP, no process concerns,
│   │   │                   no framework imports. If it needs a Request, it belongs
│   │   │                   in server/ instead.
│   │   ├── git/            Clone cache and typed wrappers over git porcelain
│   │   │                   (log, show, diff, log -S). Shells out; no libgit2.
│   │   ├── github/         App auth, installation tokens, webhook verification,
│   │   │                   REST calls.
│   │   ├── detect/         Candidate detection and ranking. The three tests live
│   │   │                   here. This is the part that decides if the product works.
│   │   ├── decisions/      Decision record shape (context · options · choice ·
│   │   │                   cost named · revisit condition) and the cost-quality check.
│   │   ├── evidence/       Anchors (repo, SHA, path, lines), verification, and
│   │   │                   detecting when a pointer has gone stale.
│   │   ├── llm/            Anthropic client, prompts, and the SHA-keyed result cache.
│   │   └── jobs/           Queue table and runner.
│   └── db/                 schema.ts and the client. Schema is cross-cutting, so it
│                           sits beside core rather than inside it.
├── web/                    Vite + React frontend. Not started.
└── var/repos/              Clone cache. Git-ignored, disposable, rebuildable.
```

### Rules that keep this from rotting

- **`core/` never imports from `server/`, `worker/`, or `cli/`.** The dependency arrow
  points one way. If core needs something from a request, pass it as an argument.
- **Entry points are thin.** They wire dependencies and translate transport. All logic
  worth testing lives in `core/`.
- **`db/schema.ts` is the constraint that outlives the features.** Schemas are expensive
  to change and features aren't — so skills, depth, and evidence get shaped so a job spec
  could be scored against them one day, even though matching is not being built.

---

## Two caches, which are not the same thing

Easy to conflate, expensive to get wrong:

1. **Result cache** — your own table, keyed on `commit_sha + analysis_version`. The same
   code is never analysed twice. This is the one that controls spend.
2. **Prompt cache** — Anthropic-side, on the stable system prompt and detector rubric
   prefix. Only works if the prefix is byte-stable, so keep timestamps, repo names, and
   user IDs *out* of the system prompt and put them in the user turn.

---

## Running it

Nothing here works yet. Recorded so the shape is agreed before the first line.

**Prerequisites**

- Node 22+, npm
- Postgres 16+ running locally
- A GitHub App (dev instance), and a tunnel — `smee.io` or similar — so webhooks reach
  `localhost`
- `ANTHROPIC_API_KEY`

**Setup**

```sh
npm install
cp .env.example .env     # fill it in — DATABASE_URL at minimum
npm run db:migrate
```

**Commands**

```sh
npm run dev          # server + worker, watch mode
npm run detect <dir> # run the detector against a local clone, print candidates, write nothing
npm run db:generate  # generate a migration from schema changes
npm run db:migrate   # apply pending migrations
npm run typecheck
npm test             # schema guarantees; skips silently without DATABASE_URL
```

`npm test` is worth running before anything else touches the database. It doesn't test
columns — it tests the claims: that `first_seen_at` cannot be rewritten, that broken
evidence survives as a claim instead of vanishing, and that a job spec can be scored
against verified skill claims without adding a table.

---

## Build order

Scope rule: **if a feature's value depends on someone other than the builder using the
product, it is not current scope.** Say so rather than building it.

1. Tradeoff capture and explain-back ← *here*
   ([0001 — dependency decision detector](./docs/features/0001-dependency-decision-detector.md),
   [0002 — capture flow](./docs/features/0002-capture-flow.md), proposed)
2. Interview prep built on that data
3. Learning goals and progression over time
4. Public profile / embed
5. Verified profiles and job-spec matching — a bet, not a roadmap item

The one exception: the data model should make matching *possible* later, even though
matching isn't being built.
