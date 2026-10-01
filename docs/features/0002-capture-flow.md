# 0002 — Capture flow (CLI)

**Status:** in progress — built together with [0003](./0003-authorship.md), whose columns share migration 0002
**Build order:** step 1, tradeoff capture
**Writes to the database:** yes — first feature that does

---

## What it is

A command that takes the detector's surfaced candidates for a local clone, asks about
them one at a time, and stores what comes back — a decision record, a learning goal, or
a dismissal with a reason.

```
npm run ask ../frontend-fixer

  1 of 3 this week · replaced  npm:@tanstack/react-router → npm:react-router-dom
    a1c93e0  2025-11-02  "switch router" · 6 months into project

  What happened here?
    [d] I chose this deliberately
    [g] I didn't know that was a choice
    [n] Not my choice (generated, inherited, someone else's)
    [x] Not really a choice / nothing depends on it
    [s] Skip for now

  > d

  Choice      react-router-dom over @tanstack/react-router
  Context     > ...
  Options     > ...
  Cost        > it's slower
  Revisit     > (enter to skip)

  Cost check: names a loss ✗ · specific to this system ✗
    "it's slower" says what's worse, not what you gave up. What did
    react-router-dom stop you doing that TanStack Router let you do?
  Revise cost? [y/N]
```

It answers the question 0001 could not: **will the builder actually answer, and is
what comes back worth anything?**

## Why this before a second detector signal

0001 ended on a fork: build capture, or find better input first (scaffold divergence,
structural patterns, a mature open-source repo). Capture comes first, for three reasons.

- **It measures 0001's precision for free.** The 7-of-10 bar was unmeasurable with five
  candidates judged by eye. Every `[n]` and `[x]` answer is a labelled false positive,
  stored against the detector version. That is the tuning loop the detector is missing.
- **It works without the detector.** Manual entry (`npm run ask --manual`) means the
  mechanic can be tested on decisions the detector cannot see yet. If capture is
  miserable to use, better input will not save it.
- **The cost check is the learning half of the product**, and it has never run on a real
  answer. Whether "names a loss" is judgeable is a bigger unknown than detector recall.

**What choosing this costs.** Recall stays where 0001 left it — five candidates across
four repos. The builder will run out of detector-prompted questions within a week or two
and lean on manual entry, which is weaker evidence (a claim, not a detection). And the
second detector signal gets designed later, with less data about what to look for.

## What it is not

- **No GitHub, no webhooks, no server.** Local clone only. Everything captured here is
  `provenance = 'retrospective'` — correctly, since nothing saw the commits arrive.
- **No LLM for the cost check, at first.** A rule-based check ships first (see §3). If
  rules cannot tell "it's slower" from "I lost type-safe route params", that is the
  finding that justifies a model — and the model gets compared against the rules on
  real answers rather than assumed better.
- **No skills tagging.** `decision_skills` stays empty. The taxonomy is an open question
  and should not be forced by the first writer.
- **No explain-back.** Asking "what does this code do" is a different mechanic with a
  different prompt shape. Separate feature.
- **No UI.** The terminal is the fast loop. The web app is designed after seeing which
  prompts people actually answer.

---

## How it works

### 1. Persist candidates

Run the detector, upsert surfaced candidates into `candidates` on the existing dedupe
key (`repo, kind, subject, introducing_sha, detector_version`). A candidate already
answered or dismissed at the same detector version is never re-asked.

`DETECTOR_VERSION` and a shared kind vocabulary come from
[0001's follow-up](./0001-dependency-decision-detector.md#follow-up--found-while-specifying-0002).

### 2. The budget

Ask at most N per week (default 3), highest `rank_score` first, using
`candidates_ask_budget_idx`. Set `asked_at` when shown. Skipped candidates return to the
pool; a candidate skipped three times goes to `expired` rather than nagging forever.

The design target from `CLAUDE.md` is a one-in-five answer rate. With the builder as the
only user that number is meaningless — it will be higher out of guilt. Record it anyway;
it becomes meaningful the day a second person runs this.

### 3. The answer

| Answer | Writes | Candidate status |
|---|---|---|
| `[d]` deliberate | `decisions` row, `origin = prompted_by_detection`, anchor from the candidate | `answered_decision` |
| `[g]` didn't know | `learning_goals` row with `candidate_id` | `answered_gap` |
| `[n]` not my choice | — | `dismissed`, `not_my_choice` |
| `[x]` not a choice / trivia | ask which: `not_a_choice` or `not_load_bearing` | `dismissed` |
| `[s]` skip | — | back to `pending` |

`[n]` and `[x]` map one-to-one onto the three tests on purpose. `--calibration` prints
dismissals grouped by reason and detector version — the output that tunes 0001.

**Choice is prefilled** from the candidate ("react-router-dom over @tanstack/react-router").
The detector already knows it; making someone type it is a cost with no signal.

Every field is optional. A record with only a cost is still worth keeping, and the
feedback says what is missing rather than refusing to save.

### 4. The cost check

Two booleans already in the schema: `cost_names_loss`, `cost_is_system_specific`.

Rule-based v1, deliberately crude:

- **Names a loss** — the sentence contains a loss construction (`gave up`, `lost`,
  `can't`, `no longer`, `instead of`, `at the cost of`, `means we`) *and* is not only a
  comparative adjective (`slower`, `heavier`, `more complex`) with nothing after it.
- **System-specific** — the sentence mentions something from this repo: a file path, a
  package name from the manifest, an identifier seen in the anchor diff, or a number.
  Generic properties of the technology ("Postgres needs a server") fail.

Each failure produces one sentence of feedback naming the missing part, and offers a
revision. Revisions go through `decision_revisions` — the check actively invites
rewriting, which is exactly why that table exists.

**Honest risk:** keyword rules will be gamed trivially and will misjudge good answers
written in unexpected words. That is acceptable for one user who is not trying to game
it. It is not acceptable as evidence, and `cost_check_version` exists so these v1
judgements can be recomputed or discounted later.

### 5. Manual entry

`npm run ask --manual <path>` skips the detector and asks for the five fields directly,
with an optional anchor (`--sha`, `--file`). `origin = entered_manually`. No candidate,
so nothing to calibrate — this is purely a claim until an anchor is attached.

---

## Decided: local repos in a GitHub-shaped schema

The schema assumes GitHub. `candidates.repo_id` and `candidates.user_id` are NOT NULL,
`repos.installation_id` and `repos.github_repo_id` are NOT NULL, and `users.github_user_id`
is NOT NULL. A local clone has none of these.

Options:

1. **Fake an installation row.** Cheapest. Also a lie in the data — a product whose
   whole claim is "tells verified from claimed" cannot start by inventing a GitHub
   installation. Rejected.
2. **Migration: `repos.source` in (`github`, `local_clone`)**, with `installation_id` and
   `github_repo_id` nullable only when `source = 'local_clone'` (CHECK constraint).
   Costs a migration and a null branch everywhere installations are joined. Buys an
   honest record of where the data came from, and a local repo can later be *linked* to
   its GitHub counterpart rather than duplicated.
3. **Don't write to Postgres yet — write decision records as Markdown into the target
   repo's `docs/decisions/`.** `origin = authored_in_repo` for free, and the detector
   could later find them. Costs: no candidates table, so no calibration loop — the main
   reason for doing this feature.

**Decided: 2.** For `users`, seed one row for the builder from env
(`RETRACE_GITHUB_USER_ID`, `RETRACE_GITHUB_LOGIN`) — it *is* their GitHub identity,
so this is not invented, and sign-in later finds the existing row.

---

## Deliverables

Edit freely — ordering reflects dependency, not priority.

**Schema** — `migrations/0002_*.sql`, `src/db/schema.ts`
- [ ] `repos.source` with the conditional-nullable CHECK (or whichever option is chosen)
- Detector kinds vs. `candidates_kind`, and the first real migrate — **moved to 0001's
  follow-up**, which also fixes the broken CHECK constraints in 0000. Must land first.

**Local identity** — `src/core/decisions/` or `src/cli/`
- [ ] Seed the builder's `users` row from env, idempotently
- [ ] Register a local clone as a `repos` row keyed on its absolute path + root commit SHA

**Detector version** — defined in 0001's follow-up
- [ ] Stored on every candidate row

**Candidate persistence** — `src/core/detect/` (pure mapping) + `src/db/` (writes)
- [ ] `RankedCandidate → candidates` row mapping, with the promoted deliberateness columns
- [ ] Upsert on the dedupe key; never re-ask an answered candidate at the same version

**Budget** — `src/core/decisions/budget.ts`
- [ ] Next N pending candidates for the user, respecting a per-week limit
- [ ] `asked_at` on show; skip counter; expire after three skips

**Cost check** — `src/core/decisions/cost-check.ts`
- [ ] `checkCost(text, context) → { namesLoss, systemSpecific, feedback[] }`, pure,
      no I/O — the repo facts it needs are passed in
- [ ] `COST_CHECK_VERSION` constant, stored alongside the result
- [ ] A fixture list of real cost sentences (good and bad) with expected verdicts —
      start from your own answers once you have some

**Recording** — `src/core/decisions/record.ts`
- [ ] Write a decision from a candidate answer, anchor copied from the candidate
- [ ] Write a learning goal from a `[g]` answer
- [ ] Write a dismissal with reason
- [ ] Every edit to a shape field writes the prior version to `decision_revisions`
- [ ] All writes for one answer in one transaction

**CLI** — `src/cli/`
- [ ] `npm run ask <path>` — interactive loop over the week's budget
- [ ] `--manual` for detector-free entry
- [ ] `--calibration` — dismissals by reason × detector version, plus answer rate
- [ ] `npm run decisions` — list what has been recorded, with what each is missing

**Tests**
- [ ] Cost check against the fixture list
- [ ] Candidate mapping round-trip (pure)
- [ ] Recording against a real database: answer → rows → status, revisions written on
      edit, re-running `ask` does not re-ask
- [ ] Skips silently without `DATABASE_URL`, like `schema.test.ts`

**Not deliverables, on purpose:** LLM cost check, skills tagging, explain-back, web UI,
GitHub App, webhooks, `pre_registered` provenance.

---

## How we will know it worked

Use it for two weeks on your own repos, then look at what is stored.

- **Did you answer?** Count answered vs. asked. If you — the builder, with every
  incentive — skip most prompts, the prompt is wrong, not the user.
- **Did the cost check change anything?** Count revisions triggered by the check, and
  compare first and final cost sentences side by side. If the revisions are not better,
  the feedback is noise. This is the single most important read.
- **Are the rules good enough?** Hand-label every cost sentence you wrote. Where the
  rules disagree with you more than one time in four, that is the case for an LLM check.
- **Calibration:** what fraction of detector-prompted candidates were dismissed, and on
  which test. That is 0001's precision number, finally measured.

**Honest risk:** a sample of one builder over two weeks is maybe fifteen answers. That is
enough to see whether the mechanic feels useful and whether the feedback bites. It is not
enough to tune weights or trust percentages. Treat the numbers as directions.

---

## Open questions

1. **Does the cost check run on save, or on demand?** On save is the teaching moment.
   It is also the moment someone is most likely to quit the flow.
2. **Should `[g]` ask anything?** A learning goal titled "react-router-dom" is useless.
   One follow-up ("what would you want to understand about it?") makes it a goal; any
   more makes admitting a gap more expensive than dismissing, which trains the wrong
   answer.
3. **Where does "Context" come from?** The builder often won't remember. Showing the
   introducing commit's diff stat and subject may be enough to jog it; showing the diff
   itself may be too much in a terminal.
4. **Does the builder re-answer after a detector version bump?** The dedupe key includes
   the version, so a bump re-surfaces everything. Probably: carry answers forward when
   `(kind, subject, introducing_sha)` matches.

---

## What this unblocks

Interview prep (build step 2) needs stored decisions with named costs — this is the
first thing that produces them. And the calibration output is what the second detector
signal should be designed against.
