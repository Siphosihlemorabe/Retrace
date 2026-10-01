# 0008 — GitHub App: commits arrive as you push

**Status:** proposed (2026-10-01). The builder chose the GitHub App over local-only tracking; agreed to build it **last**, after 0012 (product-direction §7)
**Build order:** supports steps 2–3. Last of 0007 → 0009 → 0010 → 0011 → 0012 → 0008
**Writes to the database:** yes — installations, repos, webhook deliveries, commit sightings, jobs
**Guardrails:** G1, G7, G8, G9, G13, G15 (see [how-it-works](../how-it-works.md#guardrails))
**Depends on:** [0007](./0007-project-goals-and-outcomes.md) for what to do with a new commit. Feeds [0012](./0012-profile.md)'s honest labels: GitHub's own push times and delivery records are what a hosted check will need

---

## What it is

The builder installs a GitHub App on the repos they're working in. Every push sends a
webhook to the local server. Each pushed commit is sighted at that moment, fetched, and
scanned for the outcomes the builder set as goals (0007). By the next time they open the
app, the push is already reflected in coverage and in the week's questions.

```
  git push                       GitHub                       Retrace (your machine)
  ───────────▶  push event  ───▶  smee.io  ───▶  POST /webhooks/github
                                                   1. verify signature (HMAC, before parsing)
                                                   2. store the delivery (append-only)
                                                   3. sight each commit (source: webhook)
                                                   4. queue a scan job
                                                 worker: fetch → authorship → outcome detectors
```

## Why this before anything else

**The builder chose it**, over local scanning, so that goal tracking happens as they code,
not only when they remember to open the app.

**It's the trust anchor `CLAUDE.md` has always planned.** "Written before the outcome was
known" is only provable from the moment a repo is connected. With goals (0007), that
sentence finally has something to attach to: "goal declared on 1 October, first JOIN
pushed on 3 October."

**What choosing this costs.**
- **About a day of setup before anything works:** registering a dev GitHub App, a private
  key, a webhook secret, a smee.io channel to reach `localhost`, and JWT and installation
  token handling.
- **The first moving parts that run without the builder:** a webhook route, a jobs queue,
  a worker, and a clone cache in `var/repos`.
- **A public-facing endpoint.** The route accepts requests from the internet, through
  smee, so signature verification is the security boundary, not a detail.

## The honest limit — read before relying on it

While the server runs on the builder's own laptop, **"our server saw it first" means "the
builder's own machine saw it first".** The builder holds the webhook secret and the
machine's clock, so locally recorded sighting times are **not** independent proof to
anyone else.

What *is* independently checkable, and is therefore stored:

- **GitHub's own times in the push payload** (for example `repository.pushed_at`), set
  by GitHub, not by git.
- **GitHub's delivery record**, which GitHub keeps for every webhook delivery. It can be
  fetched back through the App's API later, by a server the builder does not control.

So this feature records everything needed for verification, but the *verified* claim only
becomes real once a hosted server re-checks deliveries against GitHub's API (build steps
4–5). Until then, provenance stays `retrospective` (G9), and the UI says "seen by your
GitHub App", never "verified".

## What it is not

- **No sign-in or multi-user.** One App, one builder. Installations whose sender isn't
  `RETRACE_GITHUB_USER_ID` are recorded and ignored.
- **No hosting.** It still runs on `127.0.0.1`. smee forwards to it.
- **No GitHub write access.** Contents and metadata are read-only, no comments, no checks,
  no status badges.
- **No LLM on push** (G15). Pushes trigger rule-based scans only. Model questions (0009) are
  generated when the builder opens the app.

---

## How it works

### 1. App and installation

A dev GitHub App with **Contents: read** and **Metadata: read** permissions, and the `push`
and `installation` / `installation_repositories` events. These are the variables
`.env.example` already lists: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_WEBHOOK_SECRET`.

`installation` events create `installations` and `repos` rows (`source = 'github'`). A
GitHub repo whose root SHA matches an existing local clone is **linked**, not duplicated
(0002's plan): its goals, candidates and decisions carry over.

### 2. The webhook route

`POST /webhooks/github`, outside `/api` and with its own guard:

1. **Verify `X-Hub-Signature-256`** (HMAC-SHA256 of the raw body with the webhook secret,
   compared in constant time) **before parsing anything.** Failures are stored with
   `signature_valid = false` and answered with 401.
2. Store the delivery in `webhook_deliveries` (append-only), keyed on `X-GitHub-Delivery`,
   so a redelivery is a no-op.
3. For `push`: sight each commit (`commit_sightings`, source `webhook`, linked to the
   delivery), store GitHub's push timestamp, and enqueue a `scan` job. A large push may not
   list every commit, so the job fetches the before→after range itself.

### 3. The worker

Drains `jobs` (`FOR UPDATE SKIP LOCKED`, as the schema planned), in the same process as
the server in development.

- `scan`: get an installation token, `git fetch` into `var/repos/<repo>`, then run 0007's
  scan (authorship, outcome detectors, sightings) over the new commits.
- Retries with backoff and goes `dead` after `max_attempts`, with the error kept.

### 4. Backfill on install

When a repo is first connected, every existing commit is sighted with source `backfill`.
That is the honest boundary: anything before it is retrospective forever (G8, G9).

---

## Decision: how webhooks reach localhost

1. **smee.io** *(recommended)*. What the README already names. A free relay channel, and
   a small client forwarding to `127.0.0.1:3000`. Costs: a third party sees payloads
   (commit metadata, not code), and the channel URL is a secret to keep out of git.
2. **A tunnel (cloudflared, ngrok).** It exposes the whole server, not just one route,
   and the local API has no sign-in. Rejected for that reason.
3. **Polling GitHub instead of webhooks.** No inbound traffic at all, but no delivery
   records and no push timestamps, which loses the main reason for choosing the App.

---

## Deliverables

**GitHub client** — `src/core/github/`
- [ ] App JWT (RS256 from the private key), installation tokens, cached until expiry
- [ ] Webhook signature verification over the raw body, constant-time
- [ ] Zod schemas for the `push` and `installation` payload fields we use (G16)

**Webhook route** — `src/server/routes/webhooks.ts`
- [ ] Verify, store, sight, enqueue. Idempotent on delivery id. 401 on a bad signature
- [ ] Installation events → installations and repos, linking to existing local clones

**Jobs and worker** — `src/core/jobs/`, `src/worker/`
- [ ] Enqueue, claim with `SKIP LOCKED`, retry with backoff, dead-letter
- [ ] `scan` job: fetch with an installation token, run 0007's scan

**Schema**
- [ ] Push timestamp from GitHub on `commit_sightings` (or on the delivery), never from git
- [ ] Anything else the payloads need, decided while building and recorded in this doc

**Setup**
- [ ] `docs/setup-github-app.md`: registering the App, permissions, secrets, smee, step by step
- [ ] `npm run dev` starts server, worker and the smee client together

**Tests**
- [ ] Signature: a valid one passes, a tampered body fails, a missing header fails, and
      nothing is parsed before verification
- [ ] Redelivery of the same delivery id writes nothing new
- [ ] A recorded real `push` payload (fixture) produces sightings and one job
- [ ] The worker retries a failing job and dead-letters it at the limit

**Not deliverables, on purpose:** hosting, sign-in, other users' installations, writing
to GitHub, re-verification of deliveries against GitHub's API (that belongs with hosting),
LLM calls on push.

---

## How we will know it worked

- **Push, then open the app:** the commit's outcomes are already in coverage, with no
  `npm run` needed.
- **Nothing is lost:** after a week, every commit on the default branch has a sighting,
  and the ones made while the laptop was off arrive through GitHub's redelivery or the
  next fetch.
- **The limit is visible:** nowhere in the UI does a locally recorded time read as
  "verified".

**Honest risk:** this is the most infrastructure in the project so far, built for a
benefit (independent timestamps) that only fully pays off once the product is hosted. If
setup stalls, local scanning (0007, on every app open) still delivers the learning value.
0008 can be paused without blocking 0009.

---

## Open questions

1. **Which branch counts?** Default branch only is simplest. Feature branches would sight
   work earlier, but then a force-pushed branch has sightings of commits that later vanish.
2. **Does the laptop need to be on?** smee does not queue. GitHub's delivery log allows
   redelivery, and a fetch on startup catches anything missed. Is that enough?

## What this unblocks

Goal tracking without opening the app, and the stored GitHub records a hosted server will
need to turn "seen by your App" into "verified".
