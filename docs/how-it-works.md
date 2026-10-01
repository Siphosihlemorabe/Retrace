# How it works — system outline and guardrails

**Status:** proposed — for review
**Relationship to `CLAUDE.md`:** `CLAUDE.md` says *what* the product is and what is in
scope. This file says how the pieces fit together, and lists the rules every feature
is built against. When the two disagree, `CLAUDE.md` wins and this file gets fixed.

Every feature doc should have a **Guardrails** line naming the guardrails it touches
(e.g. `G2, G6, G9`) and saying how it keeps each one. If a feature needs to break one,
the doc says so in a decision section. It does not happen quietly in code.

---

## The loop, in one picture

```
 ┌──────────────┐   cheap reads     ┌────────────┐  budget  ┌────────────┐
 │ repo (clone, │ ────────────────▶ │ detectors  │ ───────▶ │  capture   │
 │ later GitHub)│  manifests, cfg,  │ 0001, 0004 │  N/week  │  0002      │
 └──────┬───────┘  root vs HEAD     │ + who made │  framed  └─────┬──────┘
        │                           │ it (0003)  │  by who        │
        │ webhook sighting          └─────┬──────┘  made it       │ answers
        ▼ (later)                         ▼ candidates            ▼
 ┌──────────────┐                    (+ dismissals =   ┌────────────────────────┐
 │ trust ledger │                     calibration)     │ decisions · learning   │
 │ first_seen_at│ ─────── provenance ────────────────▶ │ goals · revisions      │
 └──────────────┘                                      └───────────┬────────────┘
                                                                   │ anchors
                         ┌─────────────────────────────────────────┤
                         ▼                                         ▼
              ┌─────────────────────┐                  ┌──────────────────────┐
              │ PRACTICE (private)  │                  │ EVIDENCE (pointers)  │
              │ explain-back  0005  │  ───never───▶    │ repo · SHA · path ·  │
              │ interview prep 0007 │                  │ lines · what it shows│
              │ coached, unlimited  │                  └──────────┬───────────┘
              └─────────┬───────────┘                             │
                        │ gaps                                    ▼
                        ▼                               skill claims (verified
                 learning goals                         only while evidence is
                                                        still checkable)
                                                                  │
                                                       later: profile (step 4),
                                                       matching (step 5, a bet)
```

Read it as three flows:

1. **Finding questions.** Detectors read the repo cheaply and produce *candidates*.
   Each candidate records *who made the change*: the builder, their AI agent, a
   template, or someone else. A budget decides which few get asked, and authorship
   decides how they are asked. Dismissals flow back as calibration.
2. **Getting answers.** Capture turns an answer into a decision record (evidence-shaped)
   or a learning goal (gap-shaped). Revisions are kept.
3. **Using answers.** Practice features (explain-back, interview prep) read decisions
   and code and coach the builder. Practice can create learning goals. It **never**
   creates evidence.

Evidence, skill claims and profiles sit downstream of all three, and almost none of
that is built yet. That is deliberate: they only become valuable once there is
someone to show them to.

---

## What the real repos taught us (2026-10-01)

These findings shaped 0003–0005 and are recorded here because they shape everything
after them too.

- **Most commits in the test corpus were made by an AI agent.** In `frontend-fixer`,
  476 of 482 commits are by `gpt-engineer-app[bot]` (Lovable), and the same is true of
  `Siphosihle` (117/123) and `fixit-landing-page` (109/110). **5 of the 6 candidates
  0001 surfaces were authored by the agent.** The top-ranked "replacement" (router
  swap) sits in one 91-file agent commit called "Changes", which also turned
  `strict: true` into `strict: false`.
- **History is thin everywhere, not just in npm manifests.** Config files have 1–4
  commits per repo. The Python and Java repos are no better (3, 7 and 11 manifest
  commits). Signals that read the *current state* of the code beat signals that read
  history, for this builder.
- **Git dates are fiction in practice, not only in theory.** Every Lovable root commit
  is dated `2025-01-01`. `frontend-fixer` really started in May 2026, so any "project
  age" computed from the root commit date is 16 months off.
- **The builder has many identities.** At least four author name/email combinations
  across their repos, and one repo (`confetti`) has a second human contributor.

The audience `CLAUDE.md` describes, the developer who shipped with heavy AI help, is
the builder. The product's first job is therefore to tell *your* choice from *your
agent's* choice and to ask about each honestly.

---

## Components

| Entry point | What it does | Exists |
|---|---|---|
| `src/cli/` | The fast loop: detect, ask, practice, against a local clone | detect, ask |
| `src/server/` | Webhook receiver, API, static web app | local API for 0006 |
| `src/worker/` | Drains `jobs`: backfill, deferred analysis | no |

| Core module | Responsibility | Introduced by |
|---|---|---|
| `core/git` | Typed wrappers over git porcelain. Shells out. | 0001 |
| `core/detect` | Detectors, the three tests, authorship, ranking, catalogues | 0001, 0003, 0004 |
| `core/decisions` | Record shape, budget, framing, cost check, recording | 0002, 0003 |
| `core/practice` | Explain-back and interview sessions, judging | 0005, 0007 |
| `core/llm` | Anthropic client, versioned prompts, `analysis_cache` | 0005 |
| `core/evidence` | Anchors, re-verification, broken-pointer detection | later |
| `core/github` | App auth, webhook verification | later |
| `core/jobs` | Queue runner | later |

---

## Four kinds of data, with different rules

Most of the guardrails below come from treating these four kinds differently.

| Kind | Tables | Rule |
|---|---|---|
| **Trust ledger** | `commit_sightings`, `webhook_deliveries` | Append-only. Not derivable from anything else, so it cannot be rebuilt once lost. |
| **Derivable cache** | `commits`, `analysis_cache` | Safe to truncate and rebuild. Never the basis of a trust claim. |
| **Builder's own words** | `decisions`, `decision_revisions`, `learning_goals`, practice answers | Never rewritten by the system. Edits create revisions. |
| **Machine judgements** | `candidates.rank_score`, authorship, cost-check booleans, practice judgements | Always stored with the version of the thing that judged. Can be recomputed or thrown away. Never quietly upgraded. |

The fourth row matters most. The product makes many small automated judgements
(is this a choice, who made it, does this cost name a loss, did this explanation cover
the failure mode). Each one is a hypothesis about how to judge, and each will be wrong
in ways only real answers reveal. A version on every judgement means the hypothesis
can be replaced without losing what it said.

---

## Guardrails

Each has a rule, the reason, what enforces it, and whether that enforcement exists
today. "Review" means only a human reading the diff stands between the rule and a
violation. Those are the ones to turn into tests when it is cheap to.

### Product

**G1 · Single-user value.** A feature in current scope must be worth having with only
the builder using it. If its value needs a viewer, employer, or second user, it is
later scope. The doc says so, and it is not built.
*Enforced by:* the feature doc's "Why this before anything else". Review.

**G2 · Evidence, not scores.** No per-person score, no streaks, points, badges, or
counts of technologies known. Where a number appears (rank score, coverage), it
belongs to a *candidate* or an *answer*, never to the *person*.
*Enforced by:* review. **Proposed test:** a schema test that fails if any table
keyed on `user_id` alone has a numeric column named like `score|points|streak|level`.

**G3 · Practice and assessment never share a path.** Anything a coaching feature
produces (explain-back judgements, interview rehearsals, model feedback) cannot become
evidence or move a skill claim. If the system that coaches the answer also certifies
it, the certificate is worth nothing.
*Enforced by:* structure. `evidence_exactly_one_target` allows only decision, learning
goal or skill claim as targets, and practice tables have no foreign key into
`evidence` or `skill_claims`. **Must stay true:** a migration adding such a key is
the violation, and it needs its own decision section.

**G4 · Ask in the frame the evidence supports.** Never say "you chose" about a change
the builder did not author. Agent-made and template-made changes are asked about as
"this is in your code: did you know, and would you keep it?", never as "why did you
choose this?". Keeping an agent's choice *after understanding it* is a real decision,
and it is recorded as that, never as having made the original choice.
*Enforced by:* 0003's framing table. Review.

**G5 · Copy stays inside the honest limit.** UI and CLI text never says "verified",
"proven", "guaranteed" or "certified" about something that is a claim. It never
frames a gap as a failure, and never says or implies "we check whether you really
understand your AI code." The agent findings above make this easy to break: "your bot
made 476 of 482 commits" is a fact, and it also reads as an accusation. Lead with what
the builder can do about it.
*Enforced by:* review. **Proposed test:** a banned-phrase scan over `src/cli/**` and
`web/**` string literals, with an allow-list for the word "verified" where it names the
evidence status itself.

**G6 · Ask on a budget.** Every surface that *asks* the builder something unprompted
draws from one weekly budget (0002). Practice the builder starts themselves is not
budgeted. Prompts the product starts always are.
*Enforced by:* `core/decisions/budget.ts` once 0002 lands. Review until then.

**G7 · The model never writes the builder's answer.** Coaching asks, critiques and
names what is missing. It does not produce prose for the builder to adopt as their own
explanation or decision record. "Here is what a strong answer would *cover*" is fine.
"Here is a strong answer" is not.
*Enforced by:* prompt rubric (0005, 0007) and review of every prompt change.

### Trust

**G8 · `first_seen_at` is the only trusted time.** Git author and commit dates are
used for display only, never for provenance, for ordering trust claims, or for
"written before the outcome". Detector heuristics that need "how far into the project"
use **commit position** (nth commit of m), not date arithmetic. Lovable's
`2025-01-01` root dates show why.
*Enforced by:* the `commit_sightings` append-only trigger (0001_guards.sql) for the
data. Review for the usage. **Proposed test:** grep that `authored_at` /
`committed_at` never appear in `core/evidence` or provenance code.

**G9 · Retrospective by default.** `provenance = 'pre_registered'` only when the record
was created before its anchor commit's first sighting *and* that sighting came from a
webhook. Everything from a local clone is retrospective, and that is the right answer.
*Enforced by:* the column default. Review for the upgrade path (no code sets it yet).

**G10 · Verified is derived, never set.** `skill_claims.status` changes only through
`recompute_skill_claim_status`. Broken evidence is kept and marked, never deleted.
*Enforced by:* the function exists. **Gap:** nothing yet stops a direct `UPDATE` of
`status`. Add a trigger when skill claims get their first writer.

**G11 · Pointers, not code.** Nothing stores source code beyond what a pointer needs
(SHA, path, line range). Sending code to the LLM for analysis is allowed. Storing it
afterwards is not, and that includes inside `analysis_cache.result`. Model output may
quote at most a short excerpt (one or two lines) to make a point.
*Enforced by:* review, plus the Zod schema for each LLM result. Bound any field that
may hold quoted code.

**G12 · Authorship follows identities the builder confirmed.** A commit is the
builder's only when its author email is in their `user_git_identities`. Unknown authors
are `unknown`, not assumed to be the builder. Everything downstream of authorship (G4
framing, later attribution in team repos) inherits this.
*Enforced by:* 0003.

### Machine judgement

**G13 · Every judgement carries its version.** `DETECTOR_VERSION` (per detector, see
0004), `AUTHORSHIP_VERSION`, `COST_CHECK_VERSION`, `PROMPT_VERSION` and
`RUBRIC_VERSION` for each LLM task. A change that alters what a judgement *means*
bumps its version in the same diff as the change.
*Enforced by:* NOT NULL version columns, plus review of the bump.

**G14 · Every judgement can be disputed.** Wherever the system judges the builder
(dismissal reasons for candidates, "that wasn't my agent" for authorship, "judge was
wrong" for practice), the builder can say so in one keystroke, and that disagreement is
stored against the judge's version. Disputes are the tuning data. A judge nobody can
contradict cannot be calibrated.
*Enforced by:* each feature's deliverables.

**G15 · Cheap reads first, LLM on demand.** Detectors and authorship use no model. LLM
calls happen only when the builder asks for something (a practice session), never on
push or on a schedule in current scope. Every call goes through `core/llm`, which
checks `analysis_cache` before calling and records tokens after.
*Enforced by:* `core/llm` being the only importer of `@anthropic-ai/sdk`.
**Proposed test:** an import-graph test asserting that.

**G16 · LLM output is untrusted input.** Parsed with Zod at the boundary, rejected
rather than coerced, and stop reasons checked before content is read. A malformed
judgement is dropped and logged, not shown.
*Enforced by:* `core/llm` (0005).

**G17 · Prompts are byte-stable.** Stable rubric and instructions go in the system
prompt. Repo names, user ids, timestamps and code go in the user turn. This makes the
prompt cache possible and keeps a prompt version meaning one exact text.
*Enforced by:* prompts live as versioned constants, not template strings built per call.

### Code and data

**G18 · The dependency arrow points one way.** `core/` never imports from `cli/`,
`server/` or `worker/`. Entry points are thin.
*Enforced by:* review. **Proposed test:** the same import-graph test as G15.

**G19 · Applied migrations are never edited.** Before a migration has run anywhere it
can be regenerated (0001 follow-up). After that, only a new migration.
*Enforced by:* review. 0000 and 0001 count as applied from 0002 onwards.

**G20 · Database tests do not pass by skipping.** `schema.test.ts` skipping silently
hid a migration that could not be applied (0001 follow-up). DB tests may skip locally
without `DATABASE_URL`, but with `REQUIRE_DB=1` a skip is a failure. CI, once it
exists, sets it.
*Enforced by:* **not yet.** Small change, worth landing with 0002's tests.

**G21 · The schema stays matchable.** Skills, levels and evidence keep the shape that
would let a job spec be scored against verified claims later, even though matching is
not built. A change that would make that impossible needs a decision section.
*Enforced by:* `schema.test.ts`'s matching query.

**G22 · Code is built to an agreed spec, and stays defensible.** Claude writes the
implementation against the feature doc the builder has agreed, one reviewable
deliverable per commit, with the real choices named in comments or commit messages.
Decisions the spec leaves open go back to the builder.
*Enforced by:* how we work (`CLAUDE.md`, "How the builder wants to work").

### Enforcement status at a glance

| Enforced by the database or a test today | Review only (candidates for a test) | Not yet enforced |
|---|---|---|
| G3 (structure), G4 (framing tests, `decisions.role` trigger), G5 (copy tests on the ask frames), G6 (budget), G8 (data; commit position replaces dates), G12 (identity sets), G13 (columns), G14 (dismissals, `[a]` disputes), G20 (`REQUIRE_DB=1`), G21 | G1, G2, G7, G8 (usage), G11, G18, G19 | G10 (direct update), G15, G16 |

*Updated 2026-10-01, after 0002 and 0003 were built.*

---

## Roadmap against the build order

| Doc | Build step | Status | Main risk it tests |
|---|---|---|---|
| [0001](./features/0001-dependency-decision-detector.md) dependency detector | 1 | built | Are there real decisions in history? *Thin, and mostly agent-made.* |
| [0002](./features/0002-capture-flow.md) capture flow | 1 | built | Will the builder answer, and does the cost check bite? |
| [0003](./features/0003-authorship.md) authorship: who made this change | 1 | built | Can we tell the builder's choice from their agent's, cheaply and honestly? |
| [0004](./features/0004-inherited-settings-detector.md) inherited-settings detector | 1 | proposed | Does reading root-vs-HEAD state find more, and better, questions than history? |
| [0005](./features/0005-explain-back.md) explain-back | 1 | proposed | Can a model judge an explanation of system-specific code well enough to coach? |
| [0006](./features/0006-local-web-ui.md) local web UI | 1 | built | Can the builder comfortably take the two-week test? |
| 0007 interview prep | 2 | not written | Does rehearsing on your own decisions make you better at defending them? |

**Order and gates.**

- **0003 before 0002's `ask` command.** 0002's schema and persistence work can start
  now. Its prompts cannot be right until authorship exists (see 0003's decision
  section).
- **0004 after 0003**, because every candidate it produces needs an author to be asked
  about properly. It does not need to wait for 0002's calibration: the 0001 run already
  showed the history-based signal is starved.
- **0005 after 0002.** It can run alongside 0004. It is the first LLM feature and builds
  `core/llm`.
- **0006 local web UI** was added at the builder's request, to test the capture loop in a
  browser. It adds no capability.
- **0007 interview prep after 0005**, because it reuses the LLM plumbing and needs
  enough decisions to rehearse on. It is the first thing anyone would pay for, and it is
  fourth because without the three before it there is nothing honest to rehearse.

**Not on this list, on purpose:** the GitHub App and webhook sighting. Under G1 its
value is mostly to a future viewer, because `pre_registered` only means something to
someone checking it. But every day without it is retrospective evidence that can never
be upgraded (0001, "what choosing this costs"). That is a real tension, not a settled
question. The cheapest hedge is a sighting-only webhook route that writes
`commit_sightings` and nothing else. It is worth its own small doc once 0002 lands.
