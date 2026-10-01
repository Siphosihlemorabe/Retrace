# 0011 — Practice and check: a judge that helps, and a check that counts

**Status:** agreed (2026-10-01). The 24-hour wait and "checks open once documented" were confirmed by the builder, from [product-direction.md](../product-direction.md) §3.5–3.7
**Build order:** step 2. Fourth of 0007 → 0009 → 0010 → 0011 → 0012 → 0008
**Writes to the database:** yes — practice feedback, checks, check results; learned status
**Guardrails:** G3, G5, G7, G13, G14, G16 (see [how-it-works](../how-it-works.md#guardrails))
**Depends on:** 0009 (questions, key points, the model connection), 0010 (documented). Absorbs [0005](./0005-explain-back.md)'s judge

---

## What it is

Two modes, kept apart on purpose (CLAUDE.md: "keep practice and assessment separate"):

**Practice** is private, unlimited, and coached. You answer a question, and a model
**judges it and gives feedback**: what you got right, what you missed, and anything the
code contradicts, each pointing at lines. Retry as often as you like. **It never counts.**

```
  Practice · SQL · Joins · db/queries.sql:13
  Covered   bookings with no customer are kept                      (line 13)
  Missed    c.name is NULL for those rows; the dashboard shows it   (lines 11, 13)
  Wrong     "INNER would be faster here": not for this query        (line 13)
  [try again]  [the judge got this wrong]
```

**Check** is a **fresh question, with no hints**, judged once as **pass** or **not yet**,
never a grade. **Only a passed check counts.** After "not yet", you go back to practice,
and the next check is a fresh question on another day.

```
  Check · SQL · Joins · db/queries.sql:13
  Not yet. Your answer missed what happens to orphaned bookings on the dashboard (lines
  11, 13). Practise it, and a new check will be available tomorrow.
```

**Learned** = documented (0010) **and** a passed check. That's what moves percentages and
objectives (0007), and what the profile shows (0012).

## Why this before anything else

**The builder chose a judge that helps, and two modes** (product-direction §3.5, choice
"a"). It's also what makes the profile mean something: a coached answer proves only that
the coach helped.

**What choosing this costs.**
- **Two judge calls' worth of prompts and calibration.** Practice feedback and check
  verdicts are different jobs.
- **The same model family may coach and check.** That's a weakness (see the honest limit),
  softened by a fresh question, no hints, a different rubric, and a strict pass bar.
- **A strict bar means "not yet" will be common.** It stays motivating only if feedback
  always points at what to fix.

## The honest limit

A model judging a model-generated question about code a model may have written is not
independent assessment. It is **harder to fake than a CV** (fresh questions, no hints, real
lines, recorded answers), not proof. So the profile says "passed a check", never
"verified", and keeps CLAUDE.md's claim language.

## What it is not

- **No grades or scores.** Pass or not yet, with reasons (product-direction §8.4).
- **No retrying the same check.** After not yet, the next check is a new question, after at
  least a day.
- **No model answers** (G7). Feedback says what was covered or missed; it doesn't write the
  right answer.
- **Practice never leaks into counting.** No path from practice tables to learned,
  evidence or the profile (G3).

---

## How it works

### Practice

The question and key points come from 0009 (cached), and the answer is stored. The judge
receives the code span, the question, the key points and the answer, and returns per key
point `covered` / `partial` / `missed`, plus `incorrect` claims, each with lines and one
sentence of why. It is told explicitly not to reward length, vocabulary or confidence.
`PRACTICE_JUDGE_VERSION`. "The judge got this wrong" is recorded (G14).

### Check

- **Available** for an outcome once it's **documented**, and at most one open check per
  outcome.
- **Fresh question:** newly generated, never shown before, about a touched range of that
  outcome, preferring a different angle or range than practice used. Key points are hidden.
- **Judged once**, against a strict rubric, `CHECK_JUDGE_VERSION`. **Pass** = the essential
  key points covered, and nothing the code contradicts. Otherwise **not yet**, with
  reasons.
- **After not yet:** practice is suggested; a new check unlocks after 24 hours, with a fresh
  question.
- **Pass:** the outcome becomes **learned**. The check result (question, answer, verdict,
  reasons, date) is the record the profile shows (0012).

### Calibration

A hand-labelled set (from 0005): ten real (code, question, answer) cases, including a fluent
wrong answer and a terse right one. The check judge must agree with the builder's labels 8
times in 10, and must fail the fluent wrong answer. This is run manually before any judge
prompt change, not in `npm test`.

## Deliverables

**Schema**
- [ ] `practice_feedback` (practice answer, judge version, per-point results, incorrect claims,
      disputed)
- [ ] `checks` (user, outcome, goal, question, key points hidden, answer, verdict pass or
      not_yet, reasons, judge version, opened, answered, next available)
- [ ] Learned is derived: documented and a passed check. Never hand-set (G10's spirit)

**Core** — `src/core/practice/`
- [ ] Practice judge and feedback; dispute recording
- [ ] Check: open (fresh question), answer, judge once, verdict, 24-hour cooldown with a new
      question
- [ ] Learned status feeding 0007's percentages and objectives

**Web and CLI**
- [ ] Practice card with feedback, and try again
- [ ] Check card: no hints shown, a single submit, the verdict with reasons, and when the next
      check is available

**Tests**
- [ ] With a fake judge: practice never changes learned; a passed check does; not yet sets a
      cooldown and the next check has a different question
- [ ] An outcome can't be checked before it's documented
- [ ] Copy checks: no grade, no score, no model-written answer
- [ ] **Manual:** the hand-labelled calibration set, at 8 of 10 agreement and the fluent wrong
      answer failed

**Not deliverables, on purpose:** grades, retakes of the same question, independent
(non-model) assessment, interview mode (0013).

## How we will know it worked

- **Calibration passes** before the first real check.
- **The builder trusts a "not yet".** Disputes on check verdicts are rare, and explainable
  by re-reading the code.
- **Practice helps:** a not yet followed by practice is more often followed by a pass than
  not yet followed by nothing.

**Honest risk:** a strict judge plus a percentage the builder wants to raise is pressure to
argue with the judge. Disputes are recorded rather than overriding verdicts, so arguing
can't move the number, and a pattern of disputes is the signal to re-calibrate.
