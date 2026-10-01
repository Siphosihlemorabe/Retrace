# 0004 — Inherited-settings detector (CLI)

**Status:** proposed — for review
**Build order:** step 1, tradeoff capture
**Writes to the database:** yes — candidates, through 0002's persistence
**Guardrails:** G4, G6, G8, G13, G14, G15 (see [how-it-works](../how-it-works.md#guardrails))
**Depends on:** [0003 — authorship](./0003-authorship.md), 0002's candidate persistence

---

## What it is

A second detector. It reads load-bearing config **at the root commit and at HEAD**,
compares both with the ecosystem norm, and finds settings that matter and that nobody
may have chosen on purpose. Each one is attributed with 0003.

```
npm run detect ../frontend-fixer --detector config

  1. [0.88] diverged   type strictness: on → off            (tsconfig.json, tsconfig.app.json)
     template tanstack_start_ts had  strict: true
     HEAD has                        strict: false · strictNullChecks: false · noImplicitAny: false
     changed in e322be8 "Changes" · made by your agent · commit 5 of 482 · 91 files
     norm: create-vite and `tsc --init` both default to strict: true

npm run detect ../Siphosihle --detector config

  1. [0.74] inherited  type strictness: off                  (tsconfig.app.json)
     set by template vite_react_shadcn_ts_2026-04-20 · unchanged since
     norm: strict: true
     also in: fixit-landing-page (same template, same value)
```

And the question 0002 asks about it, in 0003's frame:

```
  2 of 3 this week · type strictness is off in 2 repos (Siphosihle, fixit-landing-page)
    set by their Lovable template, never changed

  This is how your code is type-checked. What's the story?
    [k] I know, and I'd keep it — here's why
    [g] I didn't know this was off
    [x] Doesn't matter here
    [s] Skip for now
```

## Why this before anything else

**History is thin, and HEAD isn't.** 0001's first run found dependencies arriving in one
or two bulk commits and never moving. Checking config and other ecosystems (2026-10-01)
found the same everywhere:

| | commits touching it |
|---|---|
| config files (tsconfig, vite, eslint, tailwind) in the 3 Lovable repos | 1–4 per file |
| `requirements.txt` in Konnect / DigiRoadToHealth | 3 / 7 |
| `pom.xml` across health_safe's 5 services | 11 |

Adding ecosystems to 0001 would widen coverage without fixing starvation. Comparing
**two snapshots, root and HEAD**, needs no history at all. Where there is history (the
file's 1–4 commits), it is enough to find the commit that changed a value.

**It finds what 0001 structurally can't.** Every repo above runs on settings it never
chose: strict mode off, JS allowed, lint rules disabled. Those come from the template,
and 0001 suppresses everything in the root commit as "arrived in the repo's first
commit". That suppression is right for *dependencies*, where a template's choices aren't
yours. It is wrong for *settings that shape every line written since*. You may not have
chosen `strict: false`, but 476 commits were written under it, and that is the
interview question.

**It's the purest form of "flag decisions the model made silently".** In
`frontend-fixer` the agent turned strict mode off at commit 5, inside a 91-file commit
called "Changes". Every commit after that was written without null checks. It is
load-bearing, it had a real alternative (it was literally `true` before), and the
builder very likely never saw it happen.

**The cost is system-specific and measurable.** "Turning strict mode back on here
produces N errors in M files" is a cost the cost check can recognise as specific to
this system, and nobody can write it without the repo. See the decision on measuring.

**What choosing this costs.**
- A second catalogue to grow by hand (settings families, and the norm for each), with
  0001's lesson attached: families must be narrow, and the norm must be one the builder
  would recognise.
- A new candidate kind, `inherited_setting`, so a schema change.
- Structural patterns (no retry, no pagination, sync where async was available) wait
  longer. They are the bigger prize for the AI-assisted audience, and they need per-language
  code analysis. This one is JSON plus a catalogue.

## What it is not

- **Not a linter.** It does not say a setting is wrong. `strict: false` can be a fine
  decision for a landing page. It asks whether the builder knows, and what it costs.
- **No code-file configs in v1.** `vite.config.ts`, `eslint.config.js` and
  `tailwind.config.ts` are code, not data. Reading them needs an AST or regex, which
  means a precision problem 0001 didn't have. tsconfig only, then decide (open
  question 1).
- **No template catalogue.** The root commit *is* the template, as it was committed. No
  shipping copies of create-vite's or Lovable's templates, which change monthly.
- **No LLM.** Same rule as 0001.
- **Not a dependency detector.** Dependencies stay in 0001, including its root-commit
  suppression.

---

## How it works

### 1. Settings families, not keys

`strict: false`, `strictNullChecks: false` and `noImplicitAny: false` together are one
decision, not three questions. The catalogue groups keys into **families**, like 0001's
categories:

| Family | Keys | Norm | Why load-bearing |
|---|---|---|---|
| type strictness | `strict`, `strictNullChecks`, `noImplicitAny` | strict on | Shapes every line written since. Null handling is unchecked everywhere. |
| JS interop | `allowJs`, `checkJs` | off | Untyped files can enter the type graph silently. |
| unchecked indexing | `noUncheckedIndexedAccess` | off by default; opting **in** is the signal | Opting in is rare and deliberate. It changes how every array and map access is written. |

**Norms are named, not implied.** Each family records where its norm comes from
("create-vite and `tsc --init` default to strict"). The CLI prints that source, so a
questionable norm shows up in front of the builder rather than hiding in code.

Excluded on purpose: `paths` aliases, `skipLibCheck`, `target`, `lib`. These are
conventions or trivia (test 2). Including them is how a detector starts asking
about everything.

### 2. Root vs HEAD, per family

For each family, read the effective value at the root commit and at HEAD:

| Root | HEAD | vs norm | Kind | Authorship comes from |
|---|---|---|---|---|
| = norm | ≠ norm | diverged | `scaffold_divergence` | the commit that changed it (walk the file's 1–4 commits) |
| ≠ norm | ≠ norm, unchanged | inherited | `inherited_setting` | the root commit → `template` (0003) |
| ≠ norm | = norm | brought back to norm | `scaffold_divergence` | the commit that changed it. Often the most deliberate kind |
| = norm | = norm | — | nothing | — |

The third row matters. Someone *turning strict mode on* in a template that had it off
is the strongest deliberateness signal this detector can see.

**Effective value.** tsconfig layers through `extends`, `references` and per-app files.
Lovable's templates put `strict` in `tsconfig.app.json` and `strictNullChecks` in
`tsconfig.json`. v1 resolves the file that includes `src` and reports which file each
value came from. tsconfig is JSONC (Siphosihle's has `/* */` comments), so `JSON.parse`
fails. Check whether TypeScript 7's package still exposes its config-parsing API to
JavaScript before relying on it. If not, a JSONC parser is a small, well-trodden
dependency.

### 3. Cross-repo grouping at ask time

The same template gives the same inherited setting in every repo made from it.
Candidates stay per repo, because the dedupe key and anchors need a repo. At ask time,
candidates with the same `(kind, subject_key, root template)` across the builder's
repos are **asked once**, listing every repo. One answer writes one decision or goal,
linked to each candidate. This is the budget (G6) doing its job. Asking the same
question three times is how people stop answering.

### 4. Rank

Separate weights from 0001's, in the same file pattern: alternative (automatic, since
the norm *is* the alternative), load-bearing (by family, and by measured errors if
measured), deliberate (from 0003's authorship and commit position). Kind bonus: brought
back to norm > diverged > inherited.

**Decided: versions per detector, not one global.** `DETECTOR_VERSION` in `rank.ts`
belongs to the dependency detector. This detector gets its own constant. Otherwise every
tuning change here re-surfaces every dependency candidate through 0002's dedupe key.
The question is how a row says which detector produced it. See below.

---

## Decision: how a candidate row names its detector

1. **Infer from `kind`** (`scaffold_divergence`/`inherited_setting` → config,
   `replacement`/`removal`/`dependency_choice` → dependency). No schema change. Breaks
   the day two detectors emit the same kind, and structural patterns will want
   `scaffold_divergence` too.
2. **`candidates.detector` text column with a CHECK** *(recommended)*. One column, and
   `detector_version` then means "version of *that* detector". Add it to the dedupe key.
   Costs a migration, cheap if it rides in migration 0002 with 0003's columns.
3. **Separate tables per detector.** Rejected: 0002's budget, calibration and recording
   all read one candidate table, and that is the point.

## Decision: measure the cost, or only name it

1. **Catalogue text only.** "Strict mode off: null handling is unchecked." Cheap, and
   generic, which is exactly what the cost check penalises.
2. **Measure with the repo's own compiler** *(recommended, behind `--measure`)*. Run
   `tsc --noEmit --strict` (or the family's equivalent) in the target repo and count
   errors and files. "Turning strict on here: N errors in M files" is a fact about
   *this* system, and the best possible prompt for a cost answer. Costs: needs the
   target's `node_modules`, takes seconds to minutes, and runs someone's toolchain.
   Opt-in, never during plain detection. Result cached against `(repo, HEAD SHA,
   family)`.
3. **Measure always.** Rejected: detection must stay fast and side-effect-free.

---

## Deliverables

Edit freely — ordering reflects dependency, not priority.

**Schema** — rides in migration 0002 if possible
- [ ] `inherited_setting` added to `candidates_kind`
- [ ] `candidates.detector` with CHECK (`dependency`, `config`), in the dedupe key
      (or whichever option is chosen)

**Config reading** — `src/core/detect/config/`
- [ ] Read tsconfig files at a SHA, JSONC-tolerant, surviving malformed files like 0001's
      manifest parser
- [ ] Resolve the effective value per family, recording which file supplied it
- [ ] Find the commit that changed a family's value (walk that file's history)

**Catalogue** — `src/core/detect/config/families.ts`
- [ ] The three families above, each with keys, norm, norm source, and a one-line
      load-bearing reason
- [ ] Explicit exclusion list, with reasons, the way 0001 has non-decisions

**Detection and ranking** — `src/core/detect/config/`
- [ ] Root vs HEAD classification per the table in §2
- [ ] Authorship from 0003 on every candidate
- [ ] Own weights, own threshold, own `CONFIG_DETECTOR_VERSION`
- [ ] Calibration summary, same shape as 0001's

**Measurement** — `src/core/detect/config/measure.ts`
- [ ] `--measure`: run the target's compiler with the family switched to norm; count
      errors and files. Clear failure when `node_modules` is missing

**Capture** — `src/core/decisions/`
- [ ] Cross-repo grouping at ask time, with one answer linked to every grouped candidate
- [ ] Template frame for `inherited_setting`: `[k] [g] [x] [s]`

**CLI**
- [ ] `npm run detect <path> --detector config|dependency|all` (default `all`)

**Tests**
- [ ] Fixture repo: a template root with strict on, an agent commit turning it off.
      Diverged, attributed to the agent
- [ ] Fixture repo: a template root with strict off, never changed. Inherited, attributed
      to the template
- [ ] Fixture repo: strict off at root, turned on by the builder later. Brought back to
      norm, ranked highest
- [ ] JSONC with comments and trailing commas parses
- [ ] Two repos with the same inherited setting group into one question

**Not deliverables, on purpose:** code-file configs (vite, eslint, tailwind), Python and
Java config, structural patterns, any LLM, linting advice.

---

## How we will know it worked

- **Precision, judged by hand.** Across the four repos, every surfaced candidate should
  be something the builder agrees *matters*, whether or not they chose it. The bar is
  the same 7 of 10 as 0001, measured on `[x]` answers.
- **Volume, honestly.** The four repos will probably give 3–5 candidates, which grouping
  turns into 2–3 questions. That is not more than 0001. **The win this claims is
  quality, not quantity**: system-specific costs, and settings that shape the whole
  codebase. If volume matters more than that, the next step is code-file configs
  (eslint's disabled rules are the obvious next family), not more tsconfig keys.
- **Does `--measure` change the cost answer?** For candidates asked with and without a
  measured error count, compare the cost check's `system-specific` verdict. If the
  number doesn't make the answer more specific, measuring isn't worth the toolchain risk.
- **Run both detectors on one mature open-source TypeScript repo.** 0001 recommended
  this and it has not been done. It separates "this builder's corpus is thin" from "the
  approach is thin", for both detectors at once.

**Honest risk:** "is this setting worth asking about" is a judgement about the norm, and
norms differ by community. A builder who knows exactly why strict is off will find the
question patronising the second time. Cross-repo grouping and the never-re-ask rule are
the defences. If `[k]` with a confident cost is the common answer, this detector is
asking about things the builder already knows, and should rank inherited settings lower.

---

## Open questions

1. **Which code-file config comes next?** eslint's disabled rules are the likeliest:
   Lovable's template turns rules off, and "you're not warned about unused variables"
   is a real cost. It needs an AST or careful regex. Decide after seeing tsconfig's
   precision.
2. **Should the agent's "re-scaffold" be one decision?** In `frontend-fixer`, `e322be8`
   swapped the router, swapped the React plugin and turned strict off, effectively
   moving from the TanStack Start template to the Vite one. That is three candidates
   from two detectors, but probably one decision ("move off TanStack Start"). Grouping
   by introducing commit at ask time would show that. Grouping by commit across
   detectors is a capture concern (0002/0003), not a detector one.
3. **Norm drift.** Norms change (create-vite's tsconfig has changed several times).
   Recording the norm's source in the catalogue makes a stale norm visible, not
   automatically correct.

---

## What this unblocks

More honest input for 0002, and the first candidates whose cost can be stated as a
number. Explain-back ([0005](./0005-explain-back.md)) gets a natural target: "explain
what this function does when `user` is null", asked about code written under strict
mode off. Structural patterns, the next detector after this, can reuse the
root-vs-HEAD, authorship and grouping machinery.
