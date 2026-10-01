# 0006 — Local web UI for the capture loop

**Status:** building (2026-10-01). The builder chose to build straight on and review afterwards
**Build order:** step 1, tradeoff capture (a second front end on 0002/0003, no new capability)
**Writes to the database:** yes — the same writes as `npm run ask`, through the same core functions
**Guardrails:** G1, G4, G5, G6, G7, G16, G18 (see [how-it-works](../how-it-works.md#guardrails))

---

## What it is

The capture flow from [0002](./0002-capture-flow.md) and [0003](./0003-authorship.md), in a
browser on the builder's own machine. Nothing new is asked or stored; it is the same loop
with buttons instead of letters.

```
npm run ui        →  http://127.0.0.1:3000

 ┌ Retrace ─────────────────────────────────── Ask · Decisions · Calibration · Repos ┐
 │  frontend-fixer ▾                                        2 of 3 this week          │
 │                                                                                    │
 │  replaced  npm:@tanstack/react-router → npm:react-router-dom                       │
 │  e322be8 "Changes" · made by your agent (Lovable) · 91 files · commit 5 of 482     │
 │                                                                                    │
 │  This swap is in your code. What's the story?                                      │
 │  [ I asked for it ]  [ I didn't ask, but I'd keep it ]  [ I didn't know ]  …       │
 └────────────────────────────────────────────────────────────────────────────────────┘
```

## Why this before anything else

**The builder asked for it, in order to test.** The terminal flow is built and verified, but
the builder found it hard to follow ("explain how this works, don't understand"). A
product whose first user can't comfortably use it can't answer 0002's main question,
"will the builder actually answer?" A screen with visible options and the cost check's
feedback next to the field is the cheaper way to get that answer.

**What choosing this costs.**
- **Dependencies:** Hono and its Node adapter, Zod, React, React DOM, Vite and the React
  plugin, plus types. That is most of the README's stack arriving at once, for a feature
  that adds no capability.
- **A second front end to keep in step with the CLI.** The defence is moving the shared
  orchestration (refresh candidates, build the cost context, apply an answer) into
  `core/`, so both are thin.
- **0002 said "no UI: the web app is designed after seeing which prompts people actually
  answer."** This goes against that, deliberately, and at the builder's request. The
  mitigation is that it is a plain rendering of the CLI's questions, not a design. The
  real web app is still designed later, from the calibration data.

## What it is not

- **Not hosted, not multi-user, no sign-in.** It binds to `127.0.0.1` only and serves one
  builder (G1). GitHub sign-in arrives with the GitHub App, not here.
- **Not a new flow.** Same budget (G6), same framing (G4), same cost check, same records.
  If a question reads differently here than in the terminal, that is a bug.
- **Not designed.** Readable and usable, not polished. No component library, no router
  library, no state library.
- **No public pages.** Profiles are build step 4.

---

## How it works

```
 browser (React, web/) ──JSON──▶ Hono (src/server/) ──▶ core/decisions, core/detect ──▶ Postgres
                                    ▲ Zod at the boundary (G16)       ▲ same functions as the CLI
```

- **API, JSON only.** `GET /api/me`, `GET|POST /api/repos`,
  `GET /api/repos/:id/identities`, `POST /api/identities`, `POST /api/repos/:id/refresh`,
  `GET /api/repos/:id/questions`, `POST /api/candidates/:id/shown`,
  `POST /api/candidates/:id/answer`, `POST /api/decisions/:id/revise`,
  `POST /api/repos/:id/manual`, `GET /api/decisions`, `GET /api/calibration`.
- **Showing spends the budget**, as in the CLI: the page reports a question as shown when it
  renders it, not when the list is fetched.
- **Local-only safety.** The server listens on `127.0.0.1`. It rejects requests whose
  `Host` is not `127.0.0.1`/`localhost`, which blocks DNS rebinding, and POSTs that are
  not `application/json`, so a page on another site cannot submit a form to it.
  `POST /api/repos` runs git on a path the builder types. That is acceptable only because
  nothing but this machine can reach the server.
- **One command to try it:** `npm run ui` builds the web app and serves it with the API on
  `PORT` (default 3000). For working on the UI, `npm run dev` (API, watch) and
  `npm run dev:web` (Vite with a proxy to the API) run side by side.

---

## Deliverables

**Shared orchestration** — `src/core/decisions/capture.ts`
- [x] `refreshCandidates`, `costContextFor`, `answerCandidate`: moved out of `src/cli/ask.ts`,
      which then calls them

**API** — `src/server/`
- [ ] Hono app with the routes above; request bodies validated with Zod, rejected with 400
- [ ] Host check and JSON-only POSTs; listens on 127.0.0.1
- [ ] Serves `web/dist` when built
- [ ] Response types in one file, imported type-only by the web app

**Web** — `web/`
- [ ] Vite + React + TypeScript, its own tsconfig, included in `npm run typecheck`
- [ ] Repos: add a local clone by path, pick one
- [ ] Ask: identity setup, then this week's questions with the CLI's wording and options;
      the decision form with Choice prefilled; cost-check result and revise
- [ ] Decisions: what is recorded and what each is missing
- [ ] Calibration: the CLI's `--calibration` numbers

**Scripts**
- [ ] `npm run ui`, `npm run dev`, `npm run dev:web`, `npm run build:web`

**Tests**
- [ ] API against the test database: register a repo, refresh, fetch questions, answer,
      revise; bad bodies get 400; foreign Host and non-JSON POSTs are refused

**Not deliverables, on purpose:** auth, hosting, GitHub, styling beyond readable, a client
router or state library, anything the CLI doesn't already do.

---

## How we will know it worked

- **The builder can run a week's questions without help.** That is the whole test.
- **The answers match the CLI's.** The same repo gives the same questions, wording and
  records whichever front end is used.
- **Answer rate.** If the builder answers more here than in the terminal, the terminal was
  the obstacle, and the real web app should come sooner.

**Honest risk:** a UI makes skipping cheaper than a terminal does, one click instead of one
keystroke and a thought. If `[s]` dominates here, that is a finding about the questions,
not the buttons.

---

## Open questions

1. Does the real web app (later) keep this local-only shape for practice, with only the
   profile hosted? Probably, since practice is private (CLAUDE.md), but not decided.

## What this unblocks

0002's two-week test, by a builder who can comfortably take it.
