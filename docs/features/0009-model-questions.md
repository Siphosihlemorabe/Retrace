# 0009 — Detailed questions, written by a model you connect

**Status:** proposed — for review (2026-10-01). The builder chose: rules detect, the model asks, through their own Claude Code by default
**Build order:** step 1 (explain-back) and step 3 (goals), together
**Writes to the database:** yes — generated questions (cached), explanations, model call log
**Guardrails:** G3, G5, G6, G7, G11, G13, G14, G15, G16, G17 (see [how-it-works](../how-it-works.md#guardrails))
**Depends on:** [0007](./0007-project-goals-and-outcomes.md). **Absorbs** [0005](./0005-explain-back.md)'s LLM plumbing and question generation

---

## What it is

Questions about the builder's actual code, specific enough to be worth answering. They are
written by a model the builder connects (their own Claude Code by default), from the code
the rules found.

Today (rules only):

```
  replaced  npm:@tanstack/react-router → npm:react-router-dom
  This swap is in your code. What's the story?
```

With 0009, for an outcome sighting from 0007:

```
  SQL · Joins · written by you · db/queries.sql:12-18 · commit 9

    12  SELECT b.id, b.starts_at, c.name
    13  FROM bookings b
    14  LEFT JOIN customers c ON c.id = b.customer_id
    15  WHERE b.starts_at >= $1

  Your LEFT JOIN keeps bookings that have no matching customer. What does the
  dashboard show for those rows, and is that what you want when a customer is
  deleted?

  > ____________________________________________________________

  After you answer:  a good answer would cover
    · c.name is NULL for those rows, and the UI renders it          (lines 12, 14)
    · whether customer deletion cascades, or orphans bookings       (line 14)
    · why LEFT rather than INNER, for this report                   (line 14)
  Which of these did your answer cover?  [✓] [✓] [ ]
```

And for the existing dependency candidates, the same treatment: the swap, plus the lines
where the new package is actually used.

## Why this before anything else

**It fixes the weakness the builder named:** questions are not detailed. Templates can say
*where*. Only a model reading the code can ask a good *why* about *this* code.

**It is explain-back.** `CLAUDE.md`'s core mechanic is tradeoff capture *and* explain-back.
0005 specified explain-back as a separate CLI. This version attaches it to the outcomes the
builder chose to learn, so every question is about something they said they cared about.

**What choosing this costs.**
- **Code leaves the machine** with Claude Code or the API (not with a local Ollama model).
  Asked once per repo, recorded, and switchable off.
- **Subscription usage.** `claude -p` counts against the builder's Claude plan, whose limits
  for scripted use are not documented. Hence the daily call cap.
- **Speed.** A Claude Code call takes seconds to start. Questions are generated ahead of time
  and cached, never while the builder waits on a click where that can be avoided.
- **A new kind of wrong.** A model can misread system-specific code, and the question will
  *sound* right. Line references on every key point make each claim checkable in seconds.

## What it is not

- **Not a judge.** No second model call grades the answer. The builder sees the key points
  *after* answering and marks which they covered. The judge 0005 designed (with its
  hand-labelled agreement test) stays future work, because a self-mark has nothing to be
  wrong about.
- **Not evidence.** Answers are the builder's own words, a claim. Key points are coaching,
  shown after the answer. Coaching never produces evidence (G3). Turning explanations
  into evidence needs an assessed mode with fresh questions, which is not built here.
- **No model answers** (G7). Key points say what a good answer *covers*, in a few words
  each. Never prose to adopt.
- **No model on push** (G15). Generation happens when the builder opens the app or runs
  `ask`, within the budget.
- **No model for coverage.** Rules decide what is covered (0007). The model only writes
  questions about what the rules found.

---

## How it works

### 1. One module, three providers

`src/core/llm/` is the only code that talks to a model (G15). It has one interface:
*system prompt + input + schema → validated object*. There are three adapters, chosen in
`.env` with `RETRACE_LLM`:

| `RETRACE_LLM` | How | Code leaves the machine | Cost control |
|---|---|---|---|
| `claude-cli` *(default)* | `claude -p --output-format json --tools "" --max-turns 1 --system-prompt-file <prompt>`, input on stdin. Uses the builder's Claude Code login | yes | daily call cap |
| `ollama` | HTTP to `localhost:11434` | no | none needed |
| `anthropic-api` | Anthropic SDK with `ANTHROPIC_API_KEY` | yes | daily call cap and a daily dollar cap |

`--tools ""` matters: the model gets only the code it is handed and cannot read files or
run commands in the repo.

Every response is parsed against a Zod schema and rejected (and logged) if it doesn't fit,
never coerced (G16). Claude Code's JSON envelope is not fully documented, so the adapter
reads only the result text and checks it.

### 2. What the model is given

| Target | Input |
|---|---|
| Outcome sighting (0007) | the added lines plus ±15 lines of context at that commit, the path, the outcome's name and description, who wrote it, and the goal |
| Dependency candidate (0001/0003) | the swap, and up to three files' usage of the new package at HEAD, trimmed to the relevant lines |

The system prompt is a versioned constant (`QUESTION_PROMPT_VERSION`) holding the rubric:
ask about behaviour under a condition or about cost, name lines, never "what does line 12
do", never answer, 2–4 key points with line references (G7, G17).

### 3. Output

```
{ questions: [ { text, lines: [from, to], keyPoints: [ { point, lines } ] } ] }
```

One or two questions per target. Each `point` is limited to a short phrase, so a key point
cannot smuggle in a model answer or copy the code (G7, G11).

### 4. Cache and caps

- **Cache** in `analysis_cache`, keyed on hash(provider, model, prompt version, repo, SHA,
  path, lines, target). The same code at the same commit is never sent twice, whichever
  provider.
- **Daily call cap**, `RETRACE_LLM_DAILY_CALLS` (default 20). When it is reached, the app
  falls back to the rule-based question and says so. The `anthropic-api` provider also gets
  `RETRACE_LLM_DAILY_USD`.
- **Every call logged:** provider, model, tokens or cost if reported, duration, cache hit.

### 5. Asking and answering

The weekly budget still applies (G6). The model makes each question better, not more
frequent. Priority within the budget:

1. outcomes **written by you**, not yet explained
2. outcomes **in your code** that the agent wrote ("your agent wrote this LEFT JOIN — what
   happens when…")
3. dependency candidates (0001–0003), as today

Answering an outcome question writes an **explanation**: the question, the answer, then
which key points the builder ticked after seeing them. Answering a dependency question
still writes a decision record through 0002, with the cost check, and the model's
question is stored alongside it.

0007's coverage gains its top status: **explained**, meaning written by you and answered.

---

## Decision: the default provider

1. **`claude-cli`** *(recommended, and what the builder asked about)*. Already installed,
   already paid for, best quality without a new account. Costs: subscription usage with
   undocumented scripted limits, slow startup, and code sent to Anthropic.
2. **`ollama`**. Free and offline, so nothing leaves the machine. Weaker questions, and it
   needs a capable computer. The right default for client or NDA repos.
3. **`anthropic-api`**. Best control and observability, but a separate bill.

## Decision: what to do when the model is unavailable

1. **Fall back to the rule-based question, and say so** *(recommended)*. The loop never
   blocks on a model.
2. **Wait and retry.** Better questions, but the builder may see nothing at all.

---

## Deliverables

**LLM core** — `src/core/llm/`
- [ ] Interface and three adapters (`claude-cli`, `ollama`, `anthropic-api`), selected by
      `RETRACE_LLM`. The `claude-cli` adapter passes `--tools ""` and `--max-turns 1`
- [ ] Zod validation of every result; reject and log, never coerce
- [ ] `analysis_cache` read-through with the full key; per-call log; daily caps
- [ ] Import-graph test: only `src/core/llm` spawns `claude` or imports `@anthropic-ai/sdk`
      (G15, G18)

**Questions** — `src/core/questions/`
- [ ] Input builders for outcome sightings and dependency candidates (code excerpts with
      line numbers, trimmed and bounded)
- [ ] `QUESTION_PROMPT_VERSION` prompt, and the output schema with bounded key-point length
- [ ] Rule-based fallback question for every target type

**Schema**
- [ ] `explanations` (user, target, question, answer, key points shown, ticked points,
      answered at); no foreign key to `evidence` or `skill_claims` (G3)
- [ ] `repos.llm_allowed_at`
- [ ] Generated questions linked to their cache entry and prompt version

**Capture**
- [ ] Budget ordering across outcome questions and candidates, as in §5
- [ ] Outcome answer → explanation → coverage status "explained"
- [ ] Dependency answer → decision (0002) with the model's question stored

**CLI and web**
- [ ] The question card shows the code excerpt with line numbers, the question, an answer
      box, then the key points with tick boxes
- [ ] First use per repo: consent to send code, naming the provider
- [ ] Settings line: which provider, how many calls are left today

**Tests**
- [ ] Each adapter against a fake (a stub `claude` script on PATH, a fake HTTP server), with
      no real model calls in `npm test`
- [ ] Cache hit skips the call; a prompt version bump misses; a malformed result is rejected
      and the fallback used; the daily cap falls back
- [ ] Copy checks: no score, no pass/fail, no model answer; key points stay short (G5, G7)
- [ ] **Manual, not in `npm test`:** ten real targets from the builder's repos. Are the
      questions specific to the code, and is every key point's line reference right?

**Not deliverables, on purpose:** a judging model, assessment, evidence from explanations,
model-based coverage, generation on push, voice.

---

## How we will know it worked

- **The builder says the questions are detailed now.** Measured directly: for ten
  generated questions, could each only have been asked about *this* code? Target 8 of 10.
- **Key points are right.** Every line reference checked by hand on the manual set. One wrong
  line is a prompt bug; several mean the model isn't being given enough context.
- **Answer rate rises** compared with 0002's template questions, read from calibration.
- **Within budget:** calls per day under the cap with the cache doing real work, and a
  cache hit rate above half after the first week.

**Honest risk:** a model writing questions about model-written code, answered by a builder
who didn't write it, is a loop where the builder's understanding is the only human part.
That is fine for learning, and it is why nothing here is evidence. The sharper risk is
that self-marking key points is too easy to tick generously. If every key point is always
ticked, the self-mark is noise, and a judge (0005's design) earns its place.

---

## Open questions

1. **Should the question card show the diff or the file?** The diff shows what changed; the
   file shows what it does. Leaning: the added lines with context, plus a link to the file.
2. **Does an explanation ever become evidence?** Only through an assessed mode: fresh
   questions, no key points shown, judged by something other than the coach. That is a
   separate, later feature, and a decision this doc does not make.
3. **Re-asking.** The same outcome written again in a later commit: ask again, or not? Asking
   again later is the only test of retention (step 3, progression).

## What this unblocks

Detailed, goal-driven questions in the loop the builder already uses. Interview prep (now
**0010**), which reuses the same provider module, cache and caps, pointed at decisions and
explanations instead of commits.
