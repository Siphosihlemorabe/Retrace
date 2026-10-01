# 0003 — Authorship: who made this change

**Status:** agreed — decision 1 chosen (2026-10-01); building alongside 0002
**Build order:** step 1, tradeoff capture
**Writes to the database:** yes — columns on `candidates` and `decisions`, identities
in `user_git_identities`
**Guardrails:** G4, G8, G12, G13, G14 (see [how-it-works](../how-it-works.md#guardrails))

---

## What it is

Every candidate gets a recorded answer to *who made this change*: the builder, the
builder with an agent's help, the builder's AI agent, a template, automation, or
someone else. Capture then asks in the frame that answer supports.

Today, 0002 would ask this:

```
  1 of 3 this week · replaced  npm:@tanstack/react-router → npm:react-router-dom
  What happened here?
    [d] I chose this deliberately
```

about a commit the builder did not write. With authorship it asks this instead:

```
npm run ask ../frontend-fixer

  1 of 3 this week · replaced  npm:@tanstack/react-router → npm:react-router-dom
    e322be8  "Changes"  · made by your agent (gpt-engineer-app[bot]) · 91 files
    commit 5 of 482

  This swap is in your code. What's the story?
    [a] I asked for it (or made it myself in the agent's editor)
    [k] I didn't ask, but I'd keep it — here's why
    [g] I didn't know this had changed
    [x] Not really a choice / nothing depends on it
    [s] Skip for now
```

The first time it meets an author it can't place, it asks once (outside the budget):

```
  Who is "TUMO OLORATO MOGAME" <t…@…>?   27 commits in confetti-confectionery
    [m] Me
    [o] Someone else
```

## Why this before anything else

**Because the data says so.** Run 0001 across the four test repos and look at who
authored each surfaced candidate:

| repo | surfaced | authored by the agent | by a human |
|---|---:|---:|---:|
| frontend-fixer | 4 | 4 | 0 |
| Siphosihle | 1 | 1 | 0 |
| fixit-landing-page | 0 | — | — |
| confetti-confectionery | 1 | 0 | 1 |

Five of six. The one human commit is *probably* the builder's: the name matches, but the
email is not the one they use elsewhere. That is the identity problem in §2, already
showing up in a sample of one.

The detector's best "replacement", the one 0001 called "a textbook replacement, the
strongest signal the product has", is three swaps inside one 91-file
agent commit titled "Changes". That same commit turned `strict: true` into
`strict: false`. 476 of that repo's 482 commits are by the agent.

So test 3 ("they actually chose it"), which `CLAUDE.md` calls the most important
filter, currently checks only that *someone* chose it deliberately, not *who*. 0001's
fix ("a swap is self-evidently deliberate") was right that a generator doesn't swap
things. It was wrong to let that stand in for "the builder chose it".

Without this, 0002's first real prompt asks the builder to defend a decision their
agent made. That is both the stupid question `CLAUDE.md` warns about and the
accusatory framing it forbids.

**Why it's an opportunity, not only a filter.** These agent-made decisions are exactly
the "decisions the model made silently" that `CLAUDE.md` says to flag. They are also
what an interviewer will ask about. A filter that dropped them would throw away the
most useful questions this builder has. Asking about them in the right frame turns
them into the product's main input.

**What choosing this costs.**
- 0002's `ask` command waits for this. Its schema and persistence work does not.
- A `DETECTOR_VERSION` bump (suppression changes), so 0002's open question 4 (carrying
  answers forward across a version bump) must be answered before real answers exist,
  not after.
- A new way to be wrong. Lovable commits manual edits made in its editor under the bot
  identity too, so "agent" means *committed by the agent*, not *decided by the agent*.
  The `[a]` answer exists because this judgement will often be wrong, and when it is,
  the builder's correction is the data (G14).

## What it is not

- **Not a judgement of how much AI was used.** It reads recorded authorship only. A
  commit the builder made with Copilot completions looks like the builder's, and that
  is accepted. No guessing from code style, no model.
- **Not a percentage on the person.** "476 of 482 commits by your agent" is never shown
  as a stat about the builder (G2, G5). Authorship appears per candidate, as context
  for one question.
- **Not team attribution.** `other_human` is suppressed, not modelled. Shared-repo
  attribution is still an open question in `CLAUDE.md`. This lays the foundation
  (identity sets) without designing it.
- **No GitHub API.** Identities are confirmed by the builder (`user_asserted`), not
  `github_verified`. That arrives with sign-in.

---

## How it works

### 1. Classify the introducing commit

Pure function over commit metadata. No I/O beyond what `core/git` already reads, plus
the commit message body for trailers.

| Class | Rule (first match wins) | Example from the corpus |
|---|---|---|
| `template` | Root commit, *or* subject matches a known template pattern | `Lovable · "template: vite_react_shadcn_ts_2026-04-20"` |
| `automation` | Known non-agent bots: dependency updaters, release bots | `dependabot[bot]`, `renovate[bot]` |
| `agent` | Known AI-agent identity | `gpt-engineer-app[bot]` |
| `builder_with_agent` | Builder's identity *and* a `Co-Authored-By:` trailer naming a known agent | this repo's own commits, once there are some |
| `builder` | Author email in the builder's `user_git_identities` | `confetti`'s Storybook commit |
| `other_human` | Author confirmed as someone else | `Furnx` in `confetti` |
| `unknown` | None of the above | anything not yet asked about |

`agent` and `automation` are separate on purpose. Dependabot bumping a version is not
a decision anyone made. An agent swapping a router is one, made silently. Lumping
them together would bury the second kind under the first.

**The agent catalogue starts with identities seen in the corpus and grows only from
observation**, like 0001's package catalogue and for the same reason: a guessed
identity is a wrong classification nobody notices. The generic fallback (`[bot]` suffix
not in either list) goes to `unknown`, which triggers the one-time question rather
than a guess.

Store `AUTHORSHIP_VERSION` next to the catalogue. Bump it when a rule or the catalogue
changes what a commit is classified as.

### 2. Confirm identities once

On first run against a repo, list distinct author identities with commit counts. Ask
about any not already known, highest commit count first. `[m]` writes a
`user_git_identities` row (`confirmed_via = 'user_asserted'`). `[o]` is remembered in
a small `known_other_identities` table (or a column, see open question 2) so it is not
asked again.

This question is **not** budgeted (G6). It is setup, asked once per identity, and
without it every question after it is framed wrong.

### 3. Fix "how far into the project"

`project_age_days_at_introduction` is computed from git dates, and every Lovable root
commit is dated `2025-01-01` (G8). Replace it with **commit position**: the introducing
commit's index in topological order, and the total at detection time. "Commit 5 of 482"
is honest. "16 months into project" was not.

### 4. Frame the question

| Class | Asked? | Frame | Answers |
|---|---|---|---|
| `builder`, `builder_with_agent` | yes | "Why X over Y?" — 0002 as agreed | `[d] [g] [n] [x] [s]` |
| `agent` | yes | "This is in your code. What's the story?" | `[a] [k] [g] [x] [s]` |
| `template` | no — 0004's job | — | — |
| `automation`, `other_human` | no — suppressed, visible in `--all` | — | — |
| `unknown` | after identity setup resolves it | — | — |

The agent answers map like this:

| Answer | Writes | Decision `role` | Authorship dispute recorded? |
|---|---|---|---|
| `[a]` I asked for it / did it myself | decision record, 0002's shape | `directed` | yes: the builder says the agent label was wrong |
| `[k]` didn't ask, I'd keep it | decision record, 0002's shape. Choice prefilled as "keep X" | `kept` | no |
| `[g]` didn't know | learning goal | — | no |
| `[x]` not a choice / trivia | dismissal, as 0002 | — | no |

**`kept` is the honest record and is not a lesser one.** "My agent replaced the router.
I checked what that cost, and I'd keep it because…" is the skill `CLAUDE.md` calls
"reviewing the specification, not just the output". A profile can later show it as
exactly that. What it must never do is show it as `made` (G4).

`directed` rests on the builder's word against what the commit says. That is fine for
practice and for the builder's own record. Downstream, it is a claim, the same as manual
entry.

---

## Decision: where this lands relative to 0002

1. **0003 first, folding its columns into 0002's migration** *(recommended)*. 0002's
   schema and persistence deliverables go ahead. Its `ask` CLI is built once against
   the right framing, and migration 0002 carries both features' columns. Costs: 0002's
   end-to-end loop arrives later, and two features share one migration, which is
   slightly harder to review.
2. **0002 as agreed, then 0003.** The first prompts are about agent commits. The
   builder answers `[n]`, which is a real measurement of how often the detector is
   wrong about authorship. Costs: the budget goes on questions already known to be
   badly framed, and the builder's patience is the scarcest thing in a one-user test.
3. **Minimum: store `introducing_author_email` in 0002, classify later.** Cheap and keeps
   the raw fact. Costs: the prompts are still wrong until the rest lands.

**Chosen: 1** (2026-10-01). The data is already in. Waiting for 0002 to rediscover it costs
weeks of a one-person answer budget.

---

## Deliverables

Edit freely — ordering reflects dependency, not priority.

**Git reading** — `src/core/git/`
- [ ] Author name and email, committer, and message body (for trailers) per commit
- [ ] Distinct author identities in a repo, with commit counts
- [ ] Position of a commit in topological order, and total commits at HEAD. Not
      first-parent: `e322be8` sits on a merged branch (the repo has 106 merges), so a
      first-parent walk never sees it

**Authorship** — `src/core/detect/authorship.ts`
- [ ] Agent, automation and template catalogues, seeded from the corpus only
- [ ] `classifyCommit(meta, identities) → { class, matchedRule }`. Pure, with
      `matchedRule` kept so `--all` can say *why*
- [ ] `Co-Authored-By` trailer parsing for `builder_with_agent`
- [ ] `AUTHORSHIP_VERSION`

**Detector** — `src/core/detect/dependency.ts`, `rank.ts`
- [ ] Authorship on every candidate; `other_human` and `automation` suppressed with
      their own `SuppressionReason`
- [ ] Commit position replaces date-based project age in the deliberateness test
- [ ] `DETECTOR_VERSION = 2`; CLI output shows authorship per candidate

**Schema** — migration 0002 (shared with 0002), `src/db/schema.ts`
- [ ] `candidates.introduced_by` (CHECK over the seven classes),
      `candidates.introducing_author_email`, `candidates.authorship_version`
- [ ] `candidates.commit_index_at_introduction`, `candidates.commit_count_at_detection`;
      stop writing `project_age_days_at_introduction` (see open question 3)
- [ ] `decisions.role` in (`made`, `directed`, `kept`), NOT NULL, copied at insert and
      never updated
- [ ] Somewhere to remember "this identity is not me" (open question 2)

**Identity setup** — `src/core/decisions/identity.ts` + `src/cli/`
- [ ] First-run identity prompt, outside the budget, highest commit count first
- [ ] `npm run identities` lists them and lets one be corrected

**Framing** — `src/core/decisions/` (consumed by 0002's `ask`)
- [ ] The agent frame and its four answers, mapped as in the table above
- [ ] `[a]` stores an authorship dispute against `authorship_version` and the
      introducing SHA. `--calibration` counts disputes alongside dismissals

**Tests**
- [ ] Fixture repo: a root commit with a fake 2025 date and a template subject, an agent
      commit carrying a swap, a builder commit, a dependabot bump, a `Co-Authored-By`
      commit. Each classified correctly
- [ ] Regression: the agent swap still surfaces (it must not be filtered out), framed as
      `agent`
- [ ] Commit position is unaffected by rewriting commit dates
- [ ] Copy check on the agent frame: no "you chose", no counts of agent commits (G4, G5)

**Not deliverables, on purpose:** any model-based guess at AI involvement, per-person
AI-usage statistics, `github_verified` identities, team attribution, asking about
template-introduced items (0004).

---

## How we will know it worked

- **Zero mis-framed prompts in the first two weeks.** Count `[a]` answers. Each one is a
  question that went out in the agent frame when it was actually the builder's work. A
  handful is expected (Lovable editor edits). More than one in three agent-framed
  questions means the class is meaningless for Lovable repos and needs a different rule.
- **The hand-labelled corpus.** Label the authorship of every surfaced candidate across
  the four repos by hand before building, and match it after. The table above is the
  start.
- **Identity setup takes under a minute** for the four repos, and is never asked twice.
- **`kept` records are as good as `made` ones.** Compare cost-check results between the
  two roles. If `kept` costs are consistently worse, the builder can't say what an agent
  choice cost, and that is the clearest learning-goal signal the product has.

**Honest risk:** for this builder, "agent" may be the right label for nearly everything,
and the frame then has to carry the whole product. If `[g]` dominates, the product is
mostly producing learning goals, not decision records. That is a fine product for a
learner, and a much thinner one for interview defence. Better to find that out now than
after building interview prep on top of decision records that don't exist.

---

## Open questions

1. **Is `directed` evidence or a claim?** It rests on the builder's word against the
   commit metadata. Leaning *claim*, same tier as manual entry. Revisit if Lovable (or
   another agent) records the prompt that produced a commit somewhere a pointer could
   reach.
2. **Where does "not me" live?** A column on `user_git_identities` with a `user_id` that
   isn't the builder is wrong (there is no such user). A tiny table keyed on email works,
   and it is the first shape team attribution will need. Leaning table.
3. **Drop `project_age_days_at_introduction` or keep it nullable?** It has only ever been
   applied to a throwaway cluster. If migration 0002 runs before any real migrate,
   regenerating 0000 without it is still legal (G19). Otherwise it stays as a dead
   column until a cleanup migration.
4. **Does the agent frame need the diff?** "91 files · Changes" says the agent did a lot
   at once, but not what. 0002's open question 3 (where context comes from) is sharper
   here, because the builder has never seen this change before.

---

## What this unblocks

0002's `ask`, framed correctly. [0004](./0004-inherited-settings-detector.md), whose
whole premise is telling template and agent settings from the builder's.
[0005](./0005-explain-back.md), which can aim explain-back at load-bearing code the
agent wrote, the code the builder is least likely to be able to explain and most
likely to be asked about.
