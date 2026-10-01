# CLAUDE.md

Read this before working on any part of this project. It explains what the product is,
who it's for, and the rules that decide what's in scope. It says nothing about
technology choices — those are decided per-component, by the builder.

> **Name:** not settled yet. Referred to here as "the product".

---

## What this is, in one sentence

A tool that turns code a developer has already written into a record of judgement —
what they chose, what it cost, and whether they can explain it — starting by being
genuinely useful to exactly one person: its builder.

## Who it's for

**The developer is the customer.** Not employers. This is a deliberate change from
an earlier framing and it is load-bearing for every scope decision below.

The developer has an acute, recurring, felt problem: they cannot talk about their own
work well. They shipped things — often with heavy AI assistance — and can't explain
why a choice was made, what the alternative was, or what it cost. That hurts in
interviews, in code review, and in their own learning.

Employers have a real problem too (CVs are unverifiable, AI made "here's working code"
meaningless). But they don't feel it acutely, they aren't short of applicants, and
selling a new trust signal to people who don't think they're in pain is a much harder
business. Anything employer-facing is a later bet, not the plan.

## The core thesis

Producing code is now cheap. What didn't get commoditised is judgement: knowing
whether output is right, knowing when an approach is wrong, debugging something a
model can't diagnose because it's specific to your system, and being able to say what
a choice cost you.

So the thing worth capturing shifted from **what was built** to **whether the builder
can defend it** — evidenced by what was built, not replaced by it.

**A decision is worth more when it names a cost, not just a benefit.** "I chose X
because it's fast" is generic. "I chose X, which meant giving up Y" is specific to a
real decision someone had to make. That distinction — cost named vs. not — is the
load-bearing signal across the whole product.

## Build order — read this before proposing scope

1. **Tradeoff capture and explain-back.** The core mechanic. Useful with one user.
2. **Interview prep built on that data.** The first thing anyone would pay for. Still
   needs no second user.
3. **Learning goals and progression over time.** Makes it a learning tool rather than
   a record.
4. **Public profile / embed.** Distribution as much as feature.
5. **Verified profiles and job-spec matching.** A bet, not a roadmap item.

**Changed 2026-10-01, at the builder's request: step 3 comes forward.** The product is
used *while* building, not only after. The builder sets learning goals when a project
starts ("I want to learn Docker and SQL"). Each goal is broken into concrete outcomes
(joins, aggregates, multi-stage builds…). Commits are checked as they arrive, and questions
ask about the specific code that covers, or misses, those outcomes. Steps 1 and 2 still
stand; goals become the main input to them. See
[0007](./docs/features/0007-project-goals-and-outcomes.md),
[0008](./docs/features/0008-github-app.md) and [0009](./docs/features/0009-model-questions.md).

The rule that keeps this honest: **code being present is not learning.** An outcome only
counts as progress when the builder wrote it, and only as understood when they can
explain it. "Your agent wrote a JOIN" is something to ask about, never something to credit.

**The scope rule:** if a feature's value depends on someone other than the builder
using the product, it is not current scope. Say so rather than building it.

The one exception: **the data model should be designed so matching is possible later,
even though matching isn't being built.** Schemas are expensive to change; features
aren't. Skills, depth, and evidence should be shaped so a job spec could be scored
against them one day.

---

## The core mechanic: tradeoff detection

Most real decisions never get written down. The system finds them in the code and asks.

**A candidate must pass all three tests:**

1. **There was a real alternative.** Postgres instead of SQLite is a choice. Using a
   `for` loop is not.
2. **It's load-bearing.** The choice shapes something downstream — the schema, the
   failure behaviour, the deploy story. If nothing depends on it, it's trivia.
3. **They actually chose it.** If `create-next-app` put it there, it isn't their
   decision and asking about it makes the product look stupid. This is the most
   important filter.

**Signal sources, strongest first:**

- **Replacements and reverts in history.** Someone swapped X for Y. Strongest signal
  by far — reversal only happens when the first option actually hurt.
- **Divergence from the scaffold default.** Added a dependency the template didn't
  include, changed generated config, hand-wrote something the framework offers.
- **Dependency choices with known alternatives.** ORM vs raw SQL, queue vs direct
  call. Cheap — readable from manifests, no code analysis needed.
- **Structural patterns.** Sync where async was available, no pagination, a filtered
  column with no index, a network call with no retry.

Deliberateness is answerable from the introducing diff: which commit, how far into the
project, and whether it landed alone or among 200 generated files.

**Two possible answers, both valuable, only one is evidence:**
- "I chose this deliberately, here's the cost" → a decision record.
- "I didn't know that was a choice" → a learning goal.

**Run the detector on a budget.** A handful of highest-ranked candidates per week.
If it asks about everything, people stop answering, and unanswered prompts are worth
nothing. Assume a low answer rate — design so the product works at one in five.

## The decision record

Shape (this is feedback scaffolding, not a mandatory form):
context · options considered · choice · **cost named** · revisit condition.

The revisit condition ("if writes exceed X, I'd move off SQLite") is underrated — it
shows the person understands the boundaries of their own choice.

Stored fields:

- anchor: repo, commit SHA, file path, line range
- origin: authored in repo / prompted by detection / entered manually
- the five shape fields above
- `first_seen_at` — **set by our server when the webhook arrived**
- skills touched, and the depth implied
- provenance: pre-registered or retrospective

**Cost quality check:** does the sentence refer to something *lost*, and is that loss
specific to this system rather than a generic property of the technology? Tell the
user which part of the shape is missing and let them improve it. That feedback loop
is the learning half of the product doing its work.

---

## Evidence model

**Store pointers, not code.** A commit SHA fingerprints exact code at an exact moment.
Evidence is a small row — repo, SHA, path, what it shows — that anyone can follow back
to the real code. Kilobytes, not repositories. No asking people to hand over private
source.

If the repo is deleted or history is rewritten, the pointer breaks and that evidence
drops back to a claim. **That is correct behaviour.** Verified should mean still
checkable.

**Git timestamps are not trustworthy.** Commit dates can be set to anything and
history can be rewritten. The trustworthy timestamp is when *our system first saw the
commit*, recorded server-side on webhook arrival. "Written before the outcome was
known" is only provable from the moment a repo is connected. Anything predating the
connection is weaker evidence and the profile should show that.

**Cost discipline:** cheap reads first (manifests, CI config, language stats, diffs on
push). LLM analysis only on demand — a depth claim, a completed goal, a profile view —
and cached against the commit SHA so the same code is never analysed twice. Spend
scales with meaningful events, not repo size.

## What "verified" means — and its honest limit

Something is **verified** when it can be checked against an artefact the builder
didn't just assert. Something is a **claim** when it rests on their word alone. The
product must always tell these apart and never blur them. A profile of unproven claims
should visibly look thinner than one backed by verified work. That's a feature.

**The limit, stated plainly:** a decision record is text, and models write excellent
text about tradeoffs. Someone can paste a diff into an LLM and get a better ADR than
they'd write themselves. Live, unpredictable follow-ups on their own code are the
hardest tier to fake, and even that is weakening.

So the honest claim is **"harder to fake than a CV, and cheaper to check"** — never
"guaranteed" or "proven". Don't let marketing copy or UI language overstate this.

**Keep practice and assessment separate.** Practice is private, unlimited and coached.
Assessed defence uses fresh questions and isn't retried until it passes. If the same
system that coaches answers also produces the verified evidence, the evidence is worth
nothing.

---

## The AI-assisted developer

A large part of the audience shipped code with heavy AI help and can't fully explain
it. This isn't their fault: AI removed the struggle, and the struggle was where the
learning happened. You used to learn indexes by having a slow query and no idea why.

Three features serve this, all sharing the detector's machinery:

- **Explain-back.** Ask what a piece of their code does and what it costs. Where they
  can't answer, that's a learning goal, not a failure.
- **Flag decisions the model made silently.** An ORM, a sync call, no pagination, an
  error-handling style. Teaches that a choice existed — and it's what an interviewer
  will ask about.
- **Review the specification, not just the output.** Stating constraints, catching
  what the model assumed, knowing when the answer is wrong.

**Framing rule:** never accusatory. "We check whether you really understand your AI
code" reads as an insult and nobody will try it. "Understand your codebase better" or
"get ready to defend this in an interview" is the same product, and lands.

---

## Non-goals

- Anything requiring a second user or external party to have value
- **Gamification** — streaks, points, badges. It corrupts the honesty the whole system
  depends on.
- **A single score per person.** This will keep tempting you because it's easy to
  display. It invites gaming and gives a viewer nothing to check. Show evidence, not
  scores.
- Treating breadth (number of technologies "known") as an achievement
- A logo wall of technologies. The unit is a skill *at a level*, linked to the thing
  that proves it.
- Peer review, community, moderation
- Recommending what to learn based on scraped market demand
- Minting new credentials. The value is surfacing evidence that already exists.

---

## How the builder wants to work

**Claude writes the implementation, against the feature doc the builder has agreed.**
(Changed 2026-10-01; earlier the builder wrote the code himself.) He reviews it, and
he still has to be able to defend every choice in it, which is the standard this
product holds its users to. So:

- **Build to the spec.** The edited feature doc is the brief. If the build shows the
  spec is wrong, record it in the doc (as 0001's "First run" does) and say so. Don't
  quietly diverge.
- **One deliverable per commit**, ticked in the doc in the same commit, small enough to
  review in one sitting.
- **Name the choices in the code.** Where there was a real alternative, a short comment
  or the commit message says what was picked and what it cost. That is the decision
  record this product would want to find.
- **Tests and typecheck pass before each commit.** Say plainly when something could not
  be verified.

**Still ask first:** anything the spec leaves as a decision, schema changes not in
the spec, and new dependencies.

Be frank about weaknesses in the idea. He'd rather hear where something breaks than
get agreement — that's the same standard the product holds its users to.

## Feature docs — written before the code

Every feature gets a numbered spec in `docs/features/NNNN-short-name.md` **before any
implementation starts**. The builder edits it, and that edited version is the brief.
Kept after the feature ships, updated with what actually happened.

Each doc follows the shape of `0001`:

- Header: **Status** · **Build order** step · **Writes to the database** ·
  **Guardrails** — which of [`docs/how-it-works.md`](./docs/how-it-works.md#guardrails)'s
  G-rules it touches, and how it keeps each one
- **What it is** — with an example of the output or interaction
- **Why this before anything else** — including **what choosing this costs**
- **What it is not** — scope guards, each deliberate
- **How it works**
- Any decision that must be made before starting, with options and a recommendation
- **Deliverables** — checkboxes grouped by module path, ordered by dependency, ending
  with what is *not* a deliverable on purpose
- **How we will know it worked** — measurable criteria and an honest risk
- **Open questions** and **What this unblocks**

Tick deliverables in the doc as they land. When the build reveals something, add a
section recording it (see 0001's "First run") rather than silently rewriting the plan.

## Current feature

**Built: [0002 — Capture flow](./docs/features/0002-capture-flow.md) with
[0003 — Authorship](./docs/features/0003-authorship.md)** (2026-10-01). The detector says who
made each change, and `npm run ask` asks about this week's few, framed by that, and stores
what comes back. Verified against a throwaway test database, not yet the builder's own.

**Next, before any new feature:** the builder's real `.env` (`DATABASE_URL`,
`TEST_DATABASE_URL`, `RETRACE_GITHUB_USER_ID`, `RETRACE_GITHUB_LOGIN`), `npm run db:migrate`,
then two weeks of `npm run ask` on real repos. 0002's and 0003's "How we will know it
worked" sections say what to read at the end. The cost check's fixtures become real answers
then.

**Proposed, for the builder's review (2026-10-01):** the direction change above, in three
specs, to build in this order. 0007 is what everything attaches to, and 0009 fixes the
weakness the builder named (questions not detailed enough):

1. [0007 — Project goals and learning outcomes](./docs/features/0007-project-goals-and-outcomes.md):
   SQL, Docker and Node/REST outcome lists, rule-based detection on each new commit, coverage
2. [0009 — Detailed questions via a connected model](./docs/features/0009-model-questions.md):
   the builder's own Claude Code by default (`claude -p`, tools off), Ollama or an API key
   as alternatives; cached, capped, never evidence
3. [0008 — GitHub App](./docs/features/0008-github-app.md): commits arrive on every push

Also built: [0006 — Local web UI](./docs/features/0006-local-web-ui.md) (`npm run ui`).
Deprioritised: [0004](./docs/features/0004-inherited-settings-detector.md). Partly superseded by 0009:
[0005](./docs/features/0005-explain-back.md). See [how-it-works](./docs/how-it-works.md#roadmap-against-the-build-order).

Previous: [0001 — Dependency decision detector](./docs/features/0001-dependency-decision-detector.md) — built, with its follow-up.

## Open questions

- The name.
- Skill taxonomy: how Postgres / PostgreSQL / SQL / "relational databases" resolve to
  one thing, and how much Postgres evidence counts toward SQL.
- Depth levels: need an observable definition (used it / configured beyond defaults /
  made a recorded tradeoff / debugged something system-specific), each naming the kind
  of evidence that proves it.
- Attribution in monorepos and team repos — evidence should follow the user's own
  commits.
- Fallback for work that can't be connected (NDA, client work, notebooks). Manual
  entry is fine as long as it's clearly a claim and the profile honestly looks thinner.