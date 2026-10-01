# 0005 — Explain-back (CLI)

**Status:** partly superseded (2026-10-01). The LLM plumbing and question generation moved into
[0009](./0009-model-questions.md), attached to 0007's goals. What remains here is the **judge**
(grading an answer against the code, with its hand-labelled agreement test), which is future work
**Build order:** step 1, tradeoff capture (the "explain-back" half)
**Writes to the database:** yes — new practice tables, `analysis_cache`, learning goals
**Guardrails:** G3, G5, G7, G11, G13, G14, G15, G16, G17 (see [how-it-works](../how-it-works.md#guardrails))
**Depends on:** 0002 (identity, repos, learning goals). Uses 0003's authorship to pick targets.

---

## What it is

The builder points it at their own code, or lets it pick. It asks what a piece of that
code does and what it costs, the builder answers in their own words, and a model
judges the answer *against the code*. It says what was covered, what was missed and
what was wrong, each with a line reference. Gaps can become learning goals. Nothing
here is evidence. It is practice.

```
npm run explain ../Siphosihle --pick

  src/hooks/useBookings.ts:12–48 · written by your agent · imported by 6 files

  Q1 of 2. What does this hook show the user if the request fails after
           some bookings have already loaded?

  > it shows an error message

  Covered   an error state is set and rendered                     (line 31)
  Missed    bookings already loaded stay on screen next to the
            error, so partial data looks complete                  (lines 27–29)
  Missed    there's no retry; a page refresh is the only recovery  (line 22)

  [g] make this a learning goal   [w] the judge got this wrong   [enter] next
```

*(Illustrative. The file and findings are invented to show the shape, not taken from
the repo.)*

It answers a question nothing so far can: **can a model judge an explanation of
system-specific code well enough to coach someone?**

## Why this before anything else

**It completes build step 1.** `CLAUDE.md` names tradeoff capture *and* explain-back as
the core mechanic. Capture asks about choices. Explain-back asks about *code*. For the
builder that matters most: 0003 found that their agent wrote the overwhelming majority
of the code in three of four repos. Being unable to explain it is the problem the
product exists for.

**It doesn't depend on the detector.** 0001 and 0004 find a handful of questions per
repo. Explain-back has a file's worth of questions in every file. It is the first
feature that can't run out of input.

**It is the cheapest way to build the LLM plumbing honestly.** `core/llm` (client,
versioned prompts, SHA-keyed cache, token accounting, spend ceiling) is needed by
interview prep and by any later LLM cost check. Building it for a private, low-stakes,
practice-only feature means its mistakes can't contaminate evidence (G3).

**What choosing this costs.**
- The first per-use spend. Order of ten cents a session at Opus pricing, to be measured,
  not trusted (see §5).
- **Source code leaves the machine.** File contents go to the Anthropic API. That is
  fine for the builder's own repos, and it is a decision per repo, not a default (see §6).
- Interview prep (build step 2, the first thing anyone would pay for) moves back again.
  It is the next doc, and it reuses everything built here.
- A new judge whose mistakes are harder to see than a keyword rule's. A wrong cost check
  is visibly dumb. A wrong judgement about code *sounds* right.

## What it is not

- **Not assessment.** No pass/fail, no score, no "level". Unlimited retries. Never
  evidence, never a skill claim (G3). Assessed defence with fresh questions, run by a
  different system, is a separate and much later feature, if it ever exists.
- **Not a tutor.** It does not explain the code. After the answer it says what a good
  answer would *cover*, as points with line references. It never writes a model answer
  (G7).
- **Not budgeted.** The builder starts it, so it doesn't draw from the weekly ask
  budget (G6). The spend ceiling limits it instead.
- **Not on push or on a schedule.** On demand only (G15).
- **No web UI, no voice.** Interviews are spoken, and typed answers come out shorter and
  more careful. Accepted for v1. Noted as a risk.

---

## How it works

### 1. Pick a target

Three ways in, all producing an anchor `(repo, SHA, path, line range)`:

| Mode | How | When it's best |
|---|---|---|
| `--file path[:lines]` | The builder names it | "I want to understand this bit" |
| `--decision <id>` | Files that touch a decision's subject (e.g. those importing `react-router-dom`) | Testing whether a recorded decision is understood in the code |
| `--pick` | Cheap ranking, no model: import count × share of lines authored by the agent (`git blame` + 0003), recently changed | The builder doesn't know what they don't know, which is the usual case |

`--pick` is in v1 on purpose. Asking someone to name the code they can't explain asks
them to know the thing they don't.

### 2. Generate questions (one cached LLM call per file version)

Input: the file at the anchor SHA, plus a few cheap repo facts (key dependencies,
0004's strictness setting). Output, as a validated structure (G16):

- the span worth asking about (lines)
- 1–3 questions, each about **behaviour under a condition** ("what happens when…") or
  **cost** ("what does this give up compared with…"), never "what does line 12 do"
- for each question, 2–5 **key points** a good answer covers, each with line references
  and no copied code (G11)

Cached in `analysis_cache` on `hash(repo, SHA, path, PROMPT_VERSION, model)`. The same
file at the same commit is never analysed twice. Key points are hidden until after the
answer.

### 3. Judge the answer (one LLM call per answer, not cacheable)

Input: question, key points, the span, the answer. Output per key point: `covered`,
`partial` or `missed`, with one sentence of why. Plus **`incorrect` claims**: things the
builder said that the code contradicts, with lines. Being confidently wrong about your
own code is the most important thing this can catch.

The judge is told explicitly not to reward length, vocabulary or confidence. Only
agreement with the code counts.

### 4. After the judgement

- `[g]` turns the missed points into a learning goal, titled from the question, with
  the anchor attached. Learning goals are not evidence, so G3 holds.
- `[w]` records a dispute against `JUDGE_PROMPT_VERSION` with an optional note. That
  is the judge's calibration data, as dismissals are the detector's (G14).
- Nothing else is written about the person. No running tally.

### 5. Cost control

- Result cache first (generation only, see §2).
- **Hard spend ceiling.** `RETRACE_LLM_DAILY_USD` (default small, e.g. $1). `core/llm`
  sums recorded token usage × price for the day and refuses before calling, with a
  clear message. Prices live in one constant, dated.
- Token usage recorded per call (already columns on `analysis_cache`; add them to
  judging rows).
- Prompt caching (G17) is set up correctly but **not counted on**. The rubric prefix is
  probably below the minimum cacheable size, so check `cache_read_input_tokens` before
  claiming savings.

### 6. Sending code: once per repo, explicitly

The first `explain` against a repo says plainly that file contents will be sent to the
Anthropic API, and asks. Yes is recorded on the repo (`repos.llm_allowed_at`). No means
explain-back is unavailable for that repo. Client and NDA work is exactly where this
matters, and `CLAUDE.md` already names it as a case the product must handle honestly.

---

## Decision: model and effort

`README.md` lists `claude-opus-5`. Keep it, and make the model one constant in
`core/llm`, stored on every result row (the column exists).

- **Generation** reads code carefully, and a wrong key point poisons every judgement
  after it. Use adaptive thinking and high effort. It is cached, so it runs once per file
  version.
- **Judging** is a narrower comparison. Start at the same settings, then measure a
  lower effort against the hand-labelled set (Deliverables, Tests) before lowering it.
  Do not drop to a cheaper model on cost grounds before the labelled set says quality
  holds.
- Check `stop_reason` before reading content, including refusals. Opus 5 supports
  server-side refusal fallbacks, and whether to enable them is a one-line decision for
  the builder when writing `core/llm`.

## Decision: when to show key points

1. **Never.** The builder sees only covered/missed. Hides the most useful thing.
2. **After the answer** *(recommended)*. Retrying the same question after seeing the
   key points is now recall, not understanding. That is fine for practice, and it is why
   practice can't be evidence.
3. **On request before answering.** Turns it into reading comprehension. Rejected.

---

## Deliverables

Edit freely — ordering reflects dependency, not priority.

**Dependencies**
- [ ] `@anthropic-ai/sdk`, `zod` (Zod is already in the stack table; not yet installed)

**LLM core** — `src/core/llm/`
- [ ] One client, one model constant, one price table (dated)
- [ ] `PROMPT_VERSION` / `JUDGE_PROMPT_VERSION` per task; prompts as constants (G17)
- [ ] Structured output validated with Zod; reject, don't coerce; check stop reason (G16)
- [ ] `analysis_cache` read-through, keyed with versions and model, never on SHA alone
- [ ] Token recording and the daily spend ceiling
- [ ] An interface the rest of the code depends on, so tests use a fake. No network in
      `npm test`
- [ ] The only module importing `@anthropic-ai/sdk` (G15). Add the import-graph test

**Schema** — new migration, `src/db/schema.ts`
- [ ] `practice_sessions`: user, repo, `kind` in (`explain_back`, `interview`),
      started/ended. `interview` reserved for 0007
- [ ] `practice_items`: session, anchor (SHA, path, lines), anchor authorship, question,
      key points, answer, judgement, generation cache id, prompt and judge versions,
      model, tokens, `disputed` + note, optional `learning_goal_id`
- [ ] `repos.llm_allowed_at`
- [ ] **No** foreign key from any practice table to `evidence` or `skill_claims` (G3).
      `schema.test.ts` asserts it

**Targeting** — `src/core/practice/targets.ts`
- [ ] `--file`, `--decision`, `--pick`. `--pick` uses blame share (0003 authorship) ×
      import count, with no model

**Explain-back** — `src/core/practice/explain.ts`
- [ ] Generate (cached), ask, judge, record. One transaction per answered item
- [ ] Learning goal from missed points; dispute recording

**CLI** — `src/cli/`
- [ ] `npm run explain <path> [--file|--decision|--pick]`
- [ ] First-run consent per repo
- [ ] `npm run explain --history`: past items, with disputes, for re-reading. Not a tally

**Tests**
- [ ] With a fake LLM: cache hit skips the call, a version bump misses the cache, a
      malformed response is rejected and not shown, the spend ceiling refuses
- [ ] Copy checks: no score, no pass/fail, no model answer in the output (G5, G7)
- [ ] **Hand-labelled judge set, run manually (costs money, not in `npm test`):** ten
      (span, question, answer) triples from the builder's own repos, including a fluent
      wrong answer and a terse right one, each with expected verdicts. Run it before
      changing any judge prompt or effort setting

**Not deliverables, on purpose:** assessment mode, scores, voice, web UI, automatic
scheduling, explaining code *to* the builder, interview prep.

---

## How we will know it worked

- **The judge agrees with the builder's own hand-labels** on the ten-item set, at least
  8 of 10 per verdict. Below that, the judge is the problem, and nothing built on it
  (interview prep included) should proceed.
- **The fluent-wrong answer is caught.** If the judge marks a confident, well-worded,
  wrong answer as covered, it is grading style. That single item outweighs the others.
- **Disputes are rare and specific.** Over two weeks, `[w]` on fewer than one in five
  judgements, and each disputed item is explainable by re-reading the code.
- **Learning goals from explain-back get revisited.** Count goals created from `[g]`
  that the builder later reopens or closes. If none are, the goals are a dumping ground,
  and the step 3 design (progression) needs that answer before it starts.
- **Spend is what was predicted.** Recorded cost per session within 2× of the estimate.

**Honest risk:** this is a loop of model-written code, model-written questions and a
model judge. The builder's understanding is the only human link in it. That is fine
for practice, and it is exactly why none of it can be evidence. The sharper risk is that
the judge misreads system-specific code (the code it is worst at is the code that
matters most here). Line references on every key point are the defence: each claim the
judge makes is checkable in seconds, so it can be disputed in seconds.

---

## Open questions

1. **Should explain-back re-ask after time passes?** Asking the same question two weeks
   later is the only test of retention. That is step 3 (progression) territory, and the
   schema should not make it hard: questions are cached per file version, so a
   re-ask needs only a new item against an old question.
2. **What happens when the code changes?** A cached question about a file at an old SHA
   may not apply at HEAD. Leaning: always generate against HEAD, and keep old items
   readable against their own SHA.
3. **Is the cost question answerable from one file?** "What does this give up?" often
   needs the alternative, which isn't in the file. Decisions supply it (`--decision`).
   For `--pick`, the generator may need the catalogue's alternatives from 0001 and 0004.
4. **Whose answer is it?** Nothing stops the builder pasting the code into another
   model and pasting the answer back. For private practice that only cheats the
   builder. It is the reason assessment, if it ever exists, needs live and unpredictable
   follow-ups (`CLAUDE.md`, "the limit").

---

## What this unblocks

**0007 — Interview prep** (build step 2). Same practice tables (`kind = 'interview'`),
same `core/llm`, same judge discipline. It points them at decision records instead of
code: an interviewer persona asks about a recorded decision, then follow-ups that push
on its cost and revisit condition, and a debrief says what landed and what didn't.
Explain-back is where the judge earns trust. Interview prep is where the product
earns money.
