# Product direction — what the builder wants, in their words

**Status:** confirmed by the builder (2026-10-01). Nothing below is built yet; the specs in §6 build it.
**How this was made:** from the builder's answers in conversation on 2026-10-01. Every
decision is the builder's, or a recommendation they accepted. §8 records how the last
open questions were settled.

This replaces the guesses in the first drafts of specs 0007–0009, and §9's changes are
now in `CLAUDE.md`.

---

## 1. The problem

Developers, especially ones who build with heavy AI help, often can't explain their own
code. They shipped it, but an AI made many of the choices, and the struggle where learning
used to happen is gone. That hurts in interviews, in code review, and in their own growth.

The product helps with that in two ways:

- **While building:** you say what you want to learn from a project. The product shows
  whether the project is actually making you practise it, and asks you to explain the
  code that does.
- **Over time:** it builds a profile of what you've genuinely learned, what you've
  documented, and the decisions you can defend. Each item is linked to real code, and the
  profile is shareable.

## 2. Who it is for

- **One person for now: the builder.** No other users, no sign-in for others.
- **The profile is shareable now** (builder's decision, which changes `CLAUDE.md`'s scope
  rule; see §9).

## 3. How it works, end to end

### 3.1 Connect a project

- **New or existing projects** both work.
- The **GitHub App** sees every push, so tracking happens as you code.

### 3.2 Set learning goals

- Any skill can be a goal. **There is no limit on what you want to learn.**
- Each skill is broken into **learning outcomes**. SQL, for example, becomes joins,
  aggregate functions, `GROUP BY`/`HAVING`, indexes, transactions and so on.
- **SQL, Docker and Node/REST APIs** have outcome lists written by us, checked by rules.
- **Any other skill** (Redis, for example) gets an outcome list **drafted by a model, which
  you review and edit before it is used**. Coverage the model finds is labelled **"found by
  the model"**, with a link to the code.
- **Later**, users will be able to write outcome lists themselves, because tech keeps
  growing.

### 3.3 As you code

On every push:

1. **Who wrote each line.** Every line is labelled from commit history: **your agent**
   (for example the Lovable bot), **you with an agent** (your commit, with an AI co-author
   trailer), or **you**. You can **relabel** lines ("an AI wrote this, though I committed
   it"), and your relabel counts as your word. The app does **not** guess from how code
   looks.
2. **What touches your goals.** The app finds the code that touches your goals' outcomes.
   An ORM call (for example Drizzle's `.leftJoin()`) **counts as touching** joins.
3. **Highlighted code.** In a code view, the lines that relate to your objectives (for
   example the SQL) are **highlighted**, together with who wrote them.
4. **Documenting.** You **document what those lines mean**: notes attached to lines, in
   your own words. **Then the app checks those lines for tradeoffs and alternatives**: was
   there a real alternative here, and what did this choice cost? If your note already says,
   that's done. If not, it asks one follow-up. If there was no real choice, it says so and
   asks nothing.

### 3.4 Questions

- **How many:** a **minimum of three a week**. You set the number in settings, and it
  can't go below three.
- **About what:** lines **you** wrote, lines **your agent** wrote, **big decisions**, and
  questions tied to **that project's learning objectives** (SQL questions when SQL is the
  goal). The **old dependency-swap questions are kept.**
- **Which first:** questions **linked to your objectives**, then **important** ones
  (choices other code depends on), then the rest.
- **Detail:** questions are **written by a model reading the actual code**, through your
  own Claude Code by default. Ollama or an API key are alternatives. They are cached per
  commit, with a daily cap.

### 3.5 Practice and check — two modes

- **Practice:** a model **judges your explanation and gives feedback** to help you
  improve. You can retry as often as you like. It is **private, and never counts**.
- **Check:** a **fresh question, with no hints**, judged once as **pass** or **not yet**,
  never a grade. The judge says what was right, missed or wrong, pointing at lines. **Only
  checks count** toward learning, percentages and the profile. After "not yet" you go back to
  practice, and the next check is a **fresh question on another day**, never the same one
  retried.

### 3.6 What counts as learned (the reward)

- Code being present is **touching** an outcome, never learning it, whoever wrote it.
- **Agent-written code doesn't count** until you understand it.
- An outcome is **learned** when you have **documented** it (your notes) **and explained**
  it (passed a check). That's the reward: what you learned, plus decisions documented and
  explained, including why you made them. **No points, badges or streaks.**

### 3.7 Progress percentages

- **Objective:** the outcomes you tick when setting a goal are your objective for that
  project. It's **met** when every ticked outcome is learned, shown as "4 of 4 met ✓".
- One **percentage per goal, per project**, for example **"SQL in bookings-api: 36% learned
  (4 of 11)"**, with touched-but-not-yet-learned outcomes shown next to it.
- Computed from **learned outcomes only**, out of the **full outcome list** for that skill,
  so unticking the hard ones can't inflate it.
- **Clickable:** it opens the list behind it, each item linked to the code, your notes and
  your check.
- **No single overall score for you as a person.** No streaks, points or badges.
- Purpose, in your words: to make you know you still need to improve.

### 3.8 The profile

- Covers **all your projects**: the stacks you set goals for, each with its percentages
  (depth within the stack); **real decisions** made; **whether you met your objectives** (every
  outcome you ticked for that project is learned); your **documented learning**; and **links to the code**.
- Across stacks, a **plain list sorted by most recent**, never a count of technologies as an
  achievement (`CLAUDE.md`'s rule, kept).
- **How it's shared:** a **published snapshot**. The app stays on your laptop, and "publish"
  writes a static profile page to a public link (for example GitHub Pages). It's as fresh
  as your last publish. No server, no hosting bill.
- **Public:** stacks and percentages, check results, decision records, notes you choose to
  publish, and code links.
- **Private:** practice answers and judge feedback, things not yet learned, and dismissed
  questions.
- **Honest limits shown on the profile:** links into private repos won't open for a
  viewer, so those items show as **claims**. Timestamps from your own laptop are not proof
  to anyone else.

## 4. Rules that stay

- **Code being present is not learning.** Agent code is something to ask about, never
  something to credit on its own.
- **Practice and assessment stay separate.** Coaching never produces what counts.
- **Verified and claimed are always shown apart.** The honest claim is "harder to fake
  than a CV, and cheaper to check", never "proven".
- **No single score per person. No streaks, points or badges.** Breadth is not an
  achievement.
- **Never accusatory.** Agent findings are facts about code, never a verdict on you.

## 5. What exists today (built)

The dependency detector (0001), authorship (0003), the question flow with the cost check
(0002), the terminal commands, and the local web UI (0006). See `docs/how-it-works.md`.

## 6. What this means for the specs

| Spec | Change |
|---|---|
| 0007 goals and outcomes | Rewrite: any skill; model-drafted lists for non-built-in skills, reviewed by you; per-line authorship with relabelling; highlighted objective code; touched → learned statuses; percentages |
| 0008 GitHub App | Mostly unchanged |
| 0009 detailed questions | Update: weekly number you set (min 3); priority (objective → important → rest); questions about your lines, agent lines, decisions |
| **0010 documenting** (new) | Line notes in your own words; publish choice per note |
| **0011 practice and check** (new) | The judge (coaching), and the separate check mode that counts (absorbs 0005's judge) |
| **0012 profile** (new) | Across projects; percentages; public and private split; publish a static snapshot |
| 0013 interview prep | Renumbered after these |

## 7. Build order (agreed)

**Goals and outcomes → detailed questions → documenting → practice and check → profile →
GitHub App.** Each step is usable on its own. The GitHub App comes last because the app
can already scan whenever it's opened. The cost: nothing updates between visits until it
lands.

## 8. How the last open questions were settled (2026-10-01)

1. **Documenting** is your note on the lines, then the app's check for tradeoffs and
   alternatives, as in §3.3. The builder finished the sentence: "…document what that line
   means, and we check what tradeoffs, if any, and alternatives."
2. **New skills:** the model drafts the outcome list, you review and edit it, and coverage it
   finds is labelled "found by the model".
3. **Objective met:** every outcome you ticked for that project is learned.
4. **Passing a check:** pass or not yet, with reasons. A fresh question next time.
5. **Build order:** as in §7.

## 9. `CLAUDE.md` changes (applied 2026-10-01)

1. **One-sentence description**, adding the while-building half: *"A tool that helps a
   developer learn deliberately while they build — set what you want to learn, see what
   your code actually covers, explain and document it — and turns that into a record of
   judgement and learning you can share."*
2. **Who it's for:** still one person, the builder. **The profile is shareable now**, as a
   published snapshot.
3. **Build order:** goals and outcomes, with documenting and explaining, become the core.
   The profile moves to now. Matching stays a bet.
4. **Scope rule:** add an exception for the shareable profile, the builder's decision of
   2026-10-01.
5. **Gamification:** from "no gamification" to *"No streaks, points or badges. Progress
   percentages are allowed per goal, computed only from learned outcomes, out of the full
   outcome list, and always linked to the evidence behind them."* Keep "no single score per
   person".
6. **Unchanged:** practice versus assessment, verified versus claimed, breadth not an
   achievement, the honest limit, never accusatory.
