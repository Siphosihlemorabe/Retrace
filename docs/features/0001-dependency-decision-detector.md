# 0001 — Dependency decision detector (CLI)

**Status:** built — 33 tests passing, run against four real repos
**Build order:** step 1, tradeoff capture
**Writes to the database:** nothing

---

## What it is

A command that reads a local clone, walks its manifest files backwards through history,
and prints a ranked list of dependency decisions the developer appears to have made —
with the evidence for each, and its own assessment of whether that evidence is any good.

```
npm run detect ../some-project

  1. [0.82] replaced  npm:prisma → npm:drizzle-orm
     f3a91c2  2025-08-14  "swap ORM"  · 4 files · 6 months into project
     alternative: displaced prisma (in use 112 days)
     load-bearing: imported in 9 files
     deliberate: landed alone, well after scaffold

  2. [0.71] chose     npm:hono           (category: http-framework)
     ...

  17 candidates · 6 above threshold · 11 suppressed (see --all)
```

It answers one question: **does a real repo contain enough genuine decisions to build a
product on?** Everything else waits on that answer.

## Why this before anything else

The stack is decided and the schema is written; neither is the risk. The risk is that
history turns out to be mostly scaffold noise and generated commits, in which case the
detector asks stupid questions, nobody answers, and the product has no input.

That is cheap to find out now and expensive to find out after building capture,
webhooks, and a UI around it.

**Why dependencies, when replacements are the stronger signal.** They are not separate
problems. Walking a manifest across history produces additions *and* swaps from the same
pass — so this gets the strongest signal at the cheapest signal's cost. The same walk
generalises to `requirements.txt`, `go.mod`, and `Cargo.toml` without rework.

**What choosing this costs.** Repos stay unconnected for longer, and every commit made
before connection is permanently retrospective evidence. That loss cannot be backfilled.
The mitigation is that a signature-verifying, sighting-only webhook route is small and
independent of this work — it can land alongside without competing for design attention.

## What it is not

Scope guards. Each of these is deliberate, not an oversight.

- **No LLM.** Cheap reads first. Manifest parsing and git metadata only. If this cannot
  find decisions without a model, adding a model is papering over a dead hypothesis.
- **No writes.** No candidate rows, no decision records. It prints. That keeps the
  feedback loop fast and means a bad detector version leaves no residue to clean up.
- **No GitHub, no network, no auth.** Local clone, given as an argument.
- **No asking.** It does not prompt for answers. The capture flow is a separate feature
  and should be designed after seeing what the detector actually produces.
- **One ecosystem.** npm only. Adding a second before the first one works would hide
  whether the failure was the approach or the parser.

---

## How it works

### 1. Walk the manifest

For each commit touching `package.json`, read the blob at that SHA and diff the
dependency map against its parent. Every add, remove, and version-major-bump becomes a
raw observation carrying its introducing commit.

An add whose name never previously appeared is an **origination**. An add in the same
commit as a remove — or an add closely following a remove of a package in the same
category — is a **replacement**, which is the signal worth the most.

### 2. Apply the three tests

The tests come from `CLAUDE.md`. Each gets its own evidence, and each is reported
separately so a candidate that fails one is debuggable rather than just absent.

| Test | How it is answered |
|---|---|
| **There was a real alternative** | A replacement passes automatically — the displaced package *is* the alternative. An origination passes only if the package is in a category with known alternatives (see open question 1). |
| **It's load-bearing** | Count of files importing it at HEAD. A runtime dependency imported in nine files shapes more than a dev tool imported in one. Removal without replacement is also load-bearing — it usually means something hurt. |
| **They actually chose it** | Answered entirely from the introducing diff: how many files landed in that commit, how far into the project's life, whether the manifest change landed alone, and whether the commit looks like scaffold output. This is the most important filter and the easiest to get wrong. |

### 3. Rank, and suppress

Score each candidate and print only those above a threshold. The budget is the point —
a detector that surfaces everything is the same as no detector, because nobody answers.

Suppressed candidates stay visible behind `--all` **with the reason they were
suppressed**. During tuning, the false negatives are more informative than the hits.

### 4. Report its own calibration

Print counts per rejection reason at the end of a run. If ninety percent of candidates
die on "looks scaffold-generated", that is a finding about the heuristic, not about the
repo.

---

## Deliverables

Edit freely — ordering reflects dependency, not priority.

**Git reading** — `src/core/git/`
- [x] Open an existing clone; fail clearly if the path is not a git repo
- [x] `log` for a single path, oldest-first, with SHA, author, date, subject
- [x] `show` a file's contents at a given SHA
- [x] Per-commit stats: files changed, insertions, deletions, parent count
- [x] Repo facts: first commit date, HEAD SHA, total commit count

**Manifest parsing** — `src/core/detect/manifest.ts`
- [x] Parse `package.json` into `{ name, version, kind: runtime | dev | peer }`
- [x] Diff two parsed manifests → added, removed, major-bumped
- [x] Survive malformed or absent manifests at a SHA without aborting the walk

**Known alternatives** — `src/core/detect/catalog.ts`
- [x] A hand-written map of package → category for the npm packages worth asking about
- [x] Categories carry their alternatives, so "you chose X over Y" is sayable
- [x] Explicit non-decision list (`typescript`, `@types/*`, framework-mandated peers)

**Detection** — `src/core/detect/dependency.ts`
- [x] Walk manifest history, emit raw observations
- [x] Pair removes with adds into replacements, within a configurable commit window
- [x] Compute the three tests' evidence per candidate
- [x] Count importing files at HEAD for the load-bearing test

**Ranking** — `src/core/detect/rank.ts`
- [x] Score from the three tests' evidence; weights in one named constant, not scattered
- [x] Threshold and suppression, with a recorded reason per suppressed candidate
- [x] Per-run calibration summary

**CLI** — `src/cli/index.ts`
- [x] `npm run detect <path>` with `--all`, `--json`, `--limit`
- [x] Human-readable default output; `--json` for diffing runs against each other

**Tests**
- [x] A synthetic fixture repo built in a temp dir with known, deliberate history —
      a scaffold commit, a real swap, a noise commit — so detector changes are measurable
      rather than vibes
- [x] Unit tests for manifest diffing, including the malformed cases
- [x] A ranking regression test: the fixture's known-good candidate must stay top-ranked

**Not deliverables, on purpose:** database writes, the `candidates` table, any UI, any
second ecosystem, any LLM call.

**Known limitation, accepted for now:** load-bearing is measured at HEAD, so a package
that was added and later removed always scores zero imports and fails test 2. Its
*addition* was still a decision. In practice the replacement candidate tells that story
better — "you swapped prisma for drizzle" dominates "you once chose prisma" — but a repo
that dropped something without replacing it will under-report. The fix is to count
imports at the commit before removal rather than at HEAD, at the cost of one more git
call per candidate.

---

## How we will know it worked

Run it against every repo you have with more than ~50 commits. For each, take the top ten
ranked candidates and judge them yourself:

- **Precision on test 3 — the bar that matters.** At least 7 of 10 should be choices you
  actually made, rather than scaffold output or framework-mandated. Below that, the
  product looks stupid the first time it asks, and the deliberateness heuristics need
  rework before anything else gets built.
- **Recall, spot-checked.** Pick three decisions you know you made in a repo. Did it find
  them? If they are in `--all` but suppressed, that is a ranking problem and fixable. If
  they are absent entirely, the walk is missing something structural.
- **Volume.** Roughly 3–15 candidates above threshold per active repo. Hundreds means the
  threshold is meaningless; zero or one means the signal is too narrow to build on.

**Honest risk:** your own repos may be the wrong test set. A project with forty commits
written over one week has no replacement history to mine, and heavy AI assistance
compresses exactly the deliberation this looks for. If your repos come back thin, that is
evidence about the corpus and not necessarily about the detector — test against a mature
open-source repo before concluding either way.

---

## First run — what it actually found

Run against four repos with real history: `confetti-confectionery` (59 commits),
`frontend-fixer` (482), `Siphosihle` (123), `fixit-landing-page` (110).

### The headline number

**242 candidates, 5 surfaced.** Of everything suppressed, **205 died on a single
heuristic: "arrived in the repo's first commit".**

That is not the detector being broken. Look at the manifest history rather than the
commit count:

| repo | commits | commits touching `package.json` |
|---|---:|---:|
| frontend-fixer | 482 | 4 |
| Siphosihle | 123 | 3 |
| fixit-landing-page | 110 | 2 |
| confetti-confectionery | 59 | 13 |

Dependencies arrive in one or two bulk commits and then never move. There is no
*decision over time* to mine, and the detector is reporting that accurately. This is the
corpus risk named below, confirmed on the first run.

### Two real bugs, found by the data rather than the tests

**Catalogue gaps were the binding constraint on recall.** `frontend-fixer` swapped
`@tanstack/react-router` for `react-router-dom` in one commit — a textbook replacement,
the strongest signal the product has — and the detector found nothing, because there was
no router category. Same commit also swapped `@vitejs/plugin-react` for
`@vitejs/plugin-react-swc`. Adding ten categories took both from invisible to top-ranked.
This settles open question 1 below: the catalogue is not a detail, it *is* the recall
ceiling.

**A replacement was being judged by a heuristic meant for originations.** All three
recovered swaps were then suppressed as "not deliberate" for landing in a busy commit.
That veto exists to catch dependencies riding along in generated output — but generators
*originate*, they never swap. Something has to be removed for a replacement to exist, so
a swap is self-evidently deliberate regardless of what else was in the commit. Fixed, and
guarded by a regression test that buries a swap in a sixty-file sweep.

**An over-broad category invented a swap that never happened.** Lumping build
integrations in with plugins produced `@tailwindcss/vite → tailwindcss-animate`. Categories
have to be narrow enough that every member is genuinely substitutable for every other,
which is a real constraint on how fast the catalogue can be grown.

### Against the success criteria

- **Precision: not yet measurable.** Only five candidates surfaced across four repos. All
  three replacements are genuine swaps, which is encouraging, but the sample is far too
  small to claim the 7-of-10 bar was met.
- **Recall: this is the problem.** Not precision, as expected. The binding constraints are
  catalogue coverage and a corpus with no manifest history.
- **Volume: below target.** 0–4 per repo against a target of 3–15.

### What this changes

The next detector signal should probably not be dependencies. Scaffold divergence and
structural patterns read the *code*, which these repos have in abundance, rather than
manifest history, which they barely have. Worth testing against a mature open-source
repo first to separate "the corpus is thin" from "the approach is thin" — that test has
not been run.

---

## Open questions

1. ~~**How is "has known alternatives" decided?**~~ **Answered by the first run.** The
   hand-written catalogue works, and it is also the recall ceiling — a missing category
   makes a real replacement invisible with no signal that anything was missed. Growing it
   by hand is viable but must stay narrow, since over-broad categories manufacture false
   replacements. Revisit the model-assisted option when a missed swap is more expensive
   than a wrong one.

1b. **Should a dependency in an imported repo's first commit count?** `confetti` began
   life as "joins the company pipeline" — an existing project committed wholesale. Those
   dependencies *were* chosen, just not here, and this repo holds no evidence either way.
   Suppressing is the honest answer given the evidence available, but it means imported
   repos are close to invisible. Currently unresolved, deliberately.

2. **What counts as a replacement window?** Swap-in-one-commit is unambiguous. A removal
   in March and an add in May probably is one, and probably is not if the project churned
   in between. A commit-count window is more robust than a time window on bursty repos.

3. **Does `package-lock.json` belong in the walk?** It would catch transitive shifts and
   would add enormous noise. Currently out of scope.

4. **Monorepos.** Multiple manifests at different paths, and a decision in one package
   may not be the same person's as in another. Deferred, but the walk should take a
   manifest path rather than assume repo root, so this is not a rewrite later.

---

## What this unblocks

The capture flow is the natural next feature, and it should not be designed until this
has run. Which of the five shape fields to ask for first, how many candidates a week is
tolerable, and whether the cost-quality check has anything to chew on are all questions
whose answers depend on what this actually produces.
