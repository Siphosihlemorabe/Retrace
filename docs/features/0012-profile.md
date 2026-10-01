# 0012 — A shareable profile, published as a snapshot

**Status:** agreed (2026-10-01), from [product-direction.md](../product-direction.md) §3.8
**Build order:** step 3. Fifth of 0007 → 0009 → 0010 → 0011 → 0012 → 0008
**Writes to the database:** a record of each publish (what was published, and when)
**Guardrails:** G1 (its one exception), G2, G3, G5, G9, G21 (see [how-it-works](../how-it-works.md#guardrails))
**Depends on:** 0007, 0010, 0011 (and 0002's decisions)

---

## What it is

A profile of the builder across **all their projects**, which they publish to a public
link. The app stays on their laptop. "Publish" writes a static page and pushes it (for
example to GitHub Pages).

```
  <your name> — what I've learned, and can explain
  Published 2026-11-02 · items marked "claim" can't be checked by a viewer

  SQL
    bookings-api     36% learned (4 of 11) · objective 4 of 4 met
      Joins          passed a check 2026-10-20 · my note · code ↗
      Aggregates     passed a check 2026-10-24 · my note · code ↗
      ...
    confetti         18% learned (2 of 11) · objective 2 of 5 met
  Docker
    bookings-api     27% learned (3 of 11) · objective 3 of 3 met

  Decisions I can defend
    Kept react-router-dom over TanStack Router (my agent's choice) — cost: lost typed
    route params, so src/App.tsx parses ids by hand · frontend-fixer · code ↗ (claim: private repo)
```

*(Illustrative: the numbers, dates and repo privacy are invented to show the shape.)*

## Why this before anything else

**The builder decided it's shareable now** (product-direction §2), which is the one
deliberate exception to CLAUDE.md's scope rule.

**What choosing this costs.**
- **Honesty has to be designed in, not added later.** A viewer can't ask what something
  means, so the labels must say it.
- **It's a snapshot.** As fresh as the last publish.
- **Publishing is outward-facing.** Every publish asks the builder to confirm first.

## What it is not

- **No overall score for the person** (G2). Percentages per goal, per project only.
- **No count of technologies as an achievement.** Across stacks it's a plain list, most
  recent first (CLAUDE.md, kept).
- **No hosting, no sign-in, no viewer features.** A static page.
- **Never "verified".** Items say "passed a check", "claim", or "seen by your GitHub App",
  never "verified" or "proven" (G5; 0011's honest limit).

---

## How it works

### What's public, and what's private (product-direction §3.8)

| Public | Private |
|---|---|
| stacks, percentages, objectives | practice answers and judge feedback |
| passed checks (question, answer, reasons, date) | outcomes not yet learned |
| decision records | dismissed questions |
| notes the builder marked "publish" | notes not marked "publish" |
| links to the code | — |

- **Before every publish**, the builder sees a preview of exactly what will go public, and
  confirms.
- **Code links** point at the commit and lines on GitHub. **Private repos** can't be opened
  by a viewer, so those items are labelled **claim**. Repos with no GitHub remote show no
  link and are labelled claim.
- **Dates** come from the builder's machine. They're shown as dates, never as proof of
  timing. (0008's GitHub records are stored for a hosted check later.)

### Publishing

1. A static generator renders the profile (HTML and CSS) into `var/profile/`.
2. **Publish target** (set once): a GitHub repo the builder owns, for example
   `<login>.github.io` or a `profile` repo with Pages enabled. The app commits and pushes
   with the builder's own git credentials.
3. Each publish records what was published (item ids and a content hash) and when, so the
   builder can see what's live.

## Decision: publish target — **chosen: 1** (builder, 2026-10-01)

1. **A GitHub Pages repo the builder owns** *(recommended)*. Free, under their name, and the
   same place the code lives. Costs: a second repo, and Pages setup once.
2. **Export a folder only.** The builder uploads it wherever they like. The simplest to
   build, but there's no one-click publish.

## Deliverables

- [ ] Profile data: across repos, from goals, outcomes, learned status, checks, decisions,
      published notes
- [ ] Static renderer; claim labels for private repos and remote-less repos; no score, no tally
- [ ] Preview of exactly what goes public, then confirm, then publish (commit and push to the
      target)
- [ ] A publish record: what, when, content hash
- [ ] Settings: the profile name (typed once), the publish repo, and projects hidden from the profile
- [ ] **Tests:** private data never rendered (practice, unlearned, unpublished notes); private
      repo → claim; copy checks for no "verified", no overall score, no technology count

**Not deliverables, on purpose:** hosting, viewer accounts, analytics, embeds, live
updating, job-spec matching.

## How we will know it worked

- **The builder is willing to send the link to someone**, and nothing on it overstates what's
  behind it.
- **A viewer with no explanation understands** the difference between "passed a check" and
  "claim".

**Honest risk:** the most visible thing on the page, the percentage, is the thing CLAUDE.md
warned is easiest to game and least checkable. It stays honest only because it's computed
from passed checks, out of the full list, and every number clicks through to the evidence.
If any of those three slips, the profile overstates the builder.

## Open questions

1. ~~Profile name and URL?~~ **Decided (builder, 2026-10-01):** a name the builder types
   once (it can be their GitHub username), and GitHub's free Pages address to start.
   Their own domain can be added later.
2. ~~Hide a whole project?~~ **Decided (builder, 2026-10-01):** yes, per project, at publish
   time.
