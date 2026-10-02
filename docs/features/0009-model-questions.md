# 0009 — Detailed questions, and outcome lists for any skill, via a model you connect

**Status:** built (2026-10-02); agreed 2026-10-01. Matches [product-direction.md](../product-direction.md) (§3.2, 3.4)
**Build order:** step 2. Second of 0007 → 0009 → 0010 → 0011 → 0012 → 0008
**Writes to the database:** yes — model call log and cache, generated questions, answers, model-drafted outcome lists, model-found sightings
**Guardrails:** G3, G5, G6, G7, G11, G13, G14, G15, G16, G17 (see [how-it-works](../how-it-works.md#guardrails))
**Depends on:** [0007](./0007-project-goals-and-outcomes.md). Absorbs [0005](./0005-explain-back.md)'s model plumbing

---

## What it is

Two things, both needing a model, through one connection the builder chooses (their own
Claude Code by default):

1. **Detailed questions about the actual code.** A model reads the lines and asks about
   *them*.
2. **Outcome lists for any skill.** For a skill without a built-in list (Redis, say), the
   model drafts the outcomes, the builder reviews and edits them, and the model then finds
   code that touches them, labelled **"found by the model"**.

```
  SQL · Joins · you · db/queries.sql:12-18 · commit 9

    11  SELECT b.id, b.starts_at, c.name
    12  FROM bookings b
    13  LEFT JOIN customers c ON c.id = b.customer_id

  Your LEFT JOIN keeps bookings that have no matching customer. What does the
  dashboard show for those rows, and is that what you want when a customer is deleted?

  > ____________________________________________________________
```

```
  New skill: Redis — drafted by the model, please review before it's used
    [x] Caching with TTLs           SET key value EX seconds
    [x] Cache invalidation          deleting or updating on write
    [ ] Pub/Sub                     PUBLISH / SUBSCRIBE
    [ edit ]  [ add an outcome ]  [ use this list ]
```

## Why this before anything else

**It fixes the weakness the builder named**, that questions aren't detailed. Templates can
say *where*. Only a model reading the code can ask a good *why*.

**It lifts the three-skill limit.** The builder said there should be no limit on what you
can learn. Built-in lists cover three skills. The model covers the rest, reviewed by the
builder.

**What choosing this costs.**
- **Code leaves the machine** with Claude Code or an API key (not with Ollama). Asked once
  per repo, and recorded.
- **Subscription usage.** `claude -p` counts against the builder's plan, and its limits for
  scripted use are undocumented. Hence a daily call cap.
- **Model-found coverage is less checkable than rule-found coverage.** That's why it's
  labelled, and why every item links to its lines.
- **A new kind of wrong.** A model can misread code and still sound right. Line references
  on everything keep each claim checkable.

## What it is not

- **Not judging** answers. That's 0011 (practice feedback, and checks).
- **Not "learned".** Answers here are practice. Learned needs a note (0010) and a passed
  check (0011).
- **No model answers** (G7). The model asks; it never supplies prose for the builder to
  adopt.
- **No model on push** (G15). It runs when the builder opens the app or asks.
- **No model for the built-in skills' coverage.** Rules stay rules (0007).

---

## How it works

### 1. One connection, three providers

`src/core/llm/` is the only code that talks to a model. Its interface is: *system prompt +
input + schema → validated object*. The provider is chosen in `.env` with `RETRACE_LLM`:

| `RETRACE_LLM` | How | Code leaves the machine | Limits |
|---|---|---|---|
| `claude-cli` *(default)* | `claude -p --output-format json --tools "" --max-turns 1 --system-prompt-file <prompt>`, input on stdin; uses the builder's Claude Code login | yes | daily call cap |
| `ollama` | HTTP to `localhost:11434` | no | — |
| `anthropic-api` | Anthropic SDK and `ANTHROPIC_API_KEY` | yes | daily call cap and daily dollar cap |

`--tools ""` means the model sees only what it's handed, and can't read files or run
commands. Every result is checked against a Zod schema, and rejected rather than coerced
(G16). A prompt is a versioned constant (G17). Results are cached on hash(provider, model,
prompt version, repo, SHA, path, lines, purpose), so the same code is never sent twice.
`RETRACE_LLM_DAILY_CALLS` defaults to 20, and when it's reached the app says so and falls
back to rule-based questions. Every call is logged (provider, model, duration, cache hit,
and tokens or cost when reported).

### 2. Questions

**What gets asked about** (builder's decision): lines **you** wrote, lines **your agent**
wrote, **big decisions** (the dependency candidates from 0001–0003, which are kept), and
anything tied to **this project's objectives**.

**How many:** a **weekly number the builder sets in settings, minimum 3.**

**Which first:**
1. linked to this project's **objectives**: touched outcomes, then outcomes in the objective
   with nothing touched yet ("your objective includes indexes; this query filters on
   `customer_id` with no index — …")
2. **important**: choices other code depends on (the detector's load-bearing test)
3. the rest

**Input to the model:** the touched lines plus ±15 lines of context at that commit, the path,
the outcome and its description, who wrote the lines, and the objective. For dependency
candidates: the swap, and up to three usages of the new package.

**Output:** one or two questions, each about **behaviour under a condition** or **a cost**,
naming lines, never "what does line 12 do". Each question has 2–4 short **key points** with
line references, kept for the judge (0011) and not shown here.

**Answering** stores the answer as **practice** (private, never counts). Answering a
dependency question still records a decision through 0002, with the cost check.

### 3. Outcome lists for any skill

When the builder sets a goal for a skill with no built-in list:

1. The model drafts 6–12 outcomes, each with a name, a one-line description, and what to
   look for in code.
2. **The builder reviews:** edit, remove, add, then "use this list". Nothing is used
   unreviewed.
3. The list is saved as the builder's (`source: model-drafted, reviewed`), versioned like any
   catalogue.
4. Coverage for these outcomes is found by the model reading added lines per commit, on
   demand and within the cap. It is stored as sightings with `found_by: model`, and shown
   as **"found by the model"** with links.

Later, builders write lists themselves (product-direction §3.2). The same table holds them,
with `source: builder`.

---

## Decision: what happens when the model is unavailable or capped — **chosen: 1** (builder, 2026-10-01)

1. **Fall back to rule-based questions, and say so** *(recommended)*. The loop never blocks.
2. **Wait.** Better questions, but sometimes nothing at all.

---

## Deliverables

**Model connection** — `src/core/llm/`
- [x] Interface and the three adapters; `claude-cli` passes `--tools ""` and `--max-turns 1`
- [x] Zod validation; cache with the full key; call log; daily caps
- [x] Only `src/core/llm` spawns `claude` or imports the SDK (import-graph test)
- [x] Consent per repo before code leaves the machine, naming the provider (web banner, CLI prompt)

**Questions** — `src/core/questions/`
- [x] Inputs for touched outcomes, untouched objective outcomes, and dependency candidates
- [x] Prompt (`QUESTION_PROMPT_VERSION`) and output schema, with short key points stored and
      hidden
- [x] Weekly number in settings, minimum 3, enforced; priority as in §2
- [x] Rule-based fallback for every target

**Outcome lists for any skill** — `src/core/outcomes/`
- [x] Draft prompt and schema; save as the builder's reviewed list
- [x] A review screen for the draft (Goals tab: draft, edit, add, remove, "use this list"; or write your own)
- [x] Model scan for those outcomes, giving sightings with `found_by: model` (reads HEAD, not
      each commit's added lines; see build notes)

**Schema**
- [x] `practice_answers` (user, question, answer, answered at). No foreign key to `evidence` or
      `skill_claims` (G3)
- [x] `skill_outcomes.source` in (`builtin`, `model_reviewed`, `builder`)
- [x] `repos.llm_allowed_at`; the generated question linked to its cache entry

**Web and CLI**
- [x] The question card: code excerpt with line numbers, who wrote it, the question, an
      answer box (web Ask tab and `npm run ask`)
- [x] Settings: provider, calls left today, questions per week (min 3)

**Tests**
- [x] Each adapter against a fake (a stub `claude` on PATH, a fake HTTP server); no real model
      calls in `npm test`
- [x] Cache hit, version bump, a malformed result rejected and the fallback used, caps
- [x] Copy checks: no model answer shown; key points never shown in this feature (the API
      test asserts no `keyPoints` reach the page; the prompt asks for questions only)
- [ ] **Manual:** ten real targets. *Not run: it sends real code to the builder's model,
      which needs their consent on a real project.* Is each question only askable of *this* code, and is every
      line reference right? Target 8 of 10

**Not deliverables, on purpose:** judging (0011), notes (0010), learned status, the profile,
generation on push.

---

## How we will know it worked

- **The builder says questions are detailed now**, and the manual set scores 8 of 10.
- **A Redis-style list is usable after review**, and its model-found sightings are right at
  least 8 times in 10 when checked by hand.
- **Within the cap**, with a cache hit rate above half after the first week.

**Honest risk:** model-written questions about model-written code, answered by a builder
who didn't write it, leave the builder's understanding as the only human part. That's fine
for practice, which is why nothing here counts. Counting starts at 0011's check.

---

## Build notes

- **No separate "explained" status.** This spec planned one ("written by you, and
  answered"). The product direction the builder confirmed later defines *learned* as
  documented (0010) plus a passed check (0011), and a separate 0009 status would compete
  with that. Answers here are practice only.
- **`claude -p` runs from an empty temp folder, with our own system prompt, and without
  `--bare`.** Measured on 2026-10-01 with the builder's Claude Code (Opus 5.5), for a
  one-line reply:
  - Claude Code's default prompt: about $0.017.
  - Our own short prompt: about $0.002.
  - Our own prompt, but run from inside the Retrace folder: 6,414 input tokens and $0.052,
    because Claude Code loads the project's `CLAUDE.md`. That would also have sent the
    project's instructions to the model.
  - `--bare` skips the login, so the call fails.
- **On Windows `claude` is a `.cmd` shim**, which Node can only run through a shell. The
  adapter quotes every argument itself; otherwise `--tools ""` arrives with its value lost.
- **The API-key adapter does not enable server-side refusal fallbacks.** A refusal is
  treated as "the model is unavailable" and falls back to a rule-based question, the
  builder's chosen behaviour.
- **The model scan reads the code at HEAD, not each commit's added lines.** §3 said "added
  lines per commit". Reading per commit costs one call per file per commit that touched it.
  Reading HEAD costs one call per changed file, and caching by git blob means a file that
  hasn't changed is never read again in any commit. What it gives up: a line written and then
  deleted between two scans is never seen. Whether lines were written after the goal comes
  from blame and from when this tool first saw each commit (server time, not git dates). A
  sighting counts as after the goal only if *every* line in it was, so progress is never
  overstated.
- **The cheap filter is the list's `lookFor` cues**, matched as case-insensitive substrings.
  Only matching files are read, and only around the matching lines. Code that touches an
  outcome without any cue is missed. The builder can add cues while reviewing.
- **A hit is dropped** if it names an outcome not on the list, or lines the model wasn't
  shown. The same rule applies to questions: a question about a line the model never saw
  falls back to the rule-based one.
- **New outcomes in a saved list join the objective** of every goal already set for that
  skill, as "all" does when a goal is set. The builder can untick them. *Assumption, not
  asked: confirm or change.*
- **The weekly budget is shared with 0002's dependency questions**, and spent when a
  question is shown, not when it is written. A dependency question is counted only through
  `candidates.asked_at`, so the CLI and the web can't count it twice.
- **A skip keeps its place in the week's budget.** Found by running `npm run ask`: skipping
  cleared `shown_at`, which gave the budget back, so "question 2 of 3" appeared twice. A
  skipped question now waits until next week, and counts again when it is shown then.
- **Allowing the model drops queued questions nobody has seen.** Otherwise the week's
  questions would stay rule-written after the builder said yes. Questions that were shown,
  answered or skipped are kept.
- **Coverage now leaves out retired outcomes.** Before, an outcome removed from a list stayed
  in the denominator. *Open for the builder:* editing a list after using it can now raise a
  goal's percentage by removing hard outcomes. Product-direction §3.7 says unticking must
  never do that. Removing from the list is a different act from unticking, but the effect is
  the same. Options: allow edits only before the first sighting, or keep retired outcomes in
  the denominator once anything touched them.
  **Decided (Claude's recommendation, 2026-10-02, applied at the builder's request):** the
  second. An outcome taken off a list leaves the denominator only if nothing in that project
  touched it. Once code touched it, it stays, marked "removed from the list". So a bad list
  can still be fixed before it is used, and removing hard outcomes later cannot raise the
  percentage.
- **Clicked through on a scratch repo** (no model, then `claude-cli` without consent): the
  Goals review, Ask card, consent banner and Settings all worked. No model calls were made.
  Three wording fixes came out of it.

## Open questions

1. **Diff or whole file on the question card?** Leaning: the touched lines with context, plus
   a link to the code view.
2. **The same outcome touched again later:** ask again, or not? Asking again later is the only
   test of retention.

## What this unblocks

0010 (the tradeoff check on notes uses this connection), 0011 (the judge reuses it), and
lists for any skill.
