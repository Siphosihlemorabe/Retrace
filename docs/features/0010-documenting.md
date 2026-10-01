# 0010 — Documenting: notes on your code, checked for tradeoffs and alternatives

**Status:** proposed (2026-10-01), from [product-direction.md](../product-direction.md) §3.3 step 4 and §8.1
**Build order:** step 2. Third of 0007 → 0009 → 0010 → 0011 → 0012 → 0008
**Writes to the database:** yes — notes, note revisions, tradeoff checks, disagreements
**Guardrails:** G3, G5, G7, G11, G13, G14, G16 (see [how-it-works](../how-it-works.md#guardrails))
**Depends on:** 0007 (highlighted lines, the code view), 0009 (the model connection)

---

## What it is

In the code view, the builder selects highlighted lines and **documents what they mean**,
in their own words. Then, in the builder's words, "we check what tradeoffs, if any, and
alternatives".

```
  db/queries.sql @ a41c09e — SQL · Joins
  you      ▌ 13  LEFT JOIN customers c ON c.id = b.customer_id

  Your note
  > Keeps every booking even if the customer row is gone, so the dashboard
  > still shows the booking.

  Tradeoffs and alternatives
    Alternative:  INNER JOIN would drop bookings with no customer          (line 13)
    Tradeoff:     those rows show an empty customer name in the UI          (lines 11, 13)
    ✓ Your note covers the alternative's effect
    ✗ Not covered: what the empty name costs on the dashboard
      What did choosing LEFT JOIN cost here?   [add to note]  [I disagree]
```

When there's no real choice in the lines:

```
  Tradeoffs and alternatives
    No real alternative here, so nothing to add.
```

A note on lines touching an outcome makes that outcome **documented** (0007's status).
Documented plus a passed check (0011) is **learned**.

## Why this before anything else

**The builder defined learned as "documented and explained"** (product-direction §3.6).
Documenting is half of that, and it's the half in the builder's own words, which is what
the record is worth.

**The tradeoff check is the cost check, grown up.** 0002's rule-based check asks whether a
cost names a loss specific to this system. A model reading the lines can also say *whether
a real alternative existed at all*. That stops the product asking "what's the tradeoff?"
about a line with no choice in it, the stupid question `CLAUDE.md` warns about.

**What choosing this costs.**
- **One model call per note**, cached per commit and lines, and within 0009's daily cap.
- **The model can be wrong about alternatives.** Each one it names points at lines, and
  "I disagree" is one click. Disagreements are recorded against the prompt version (G14),
  like detector dismissals.

## What it is not

- **Not the explanation.** Explaining is 0011's check: a fresh question, no hints. A note is
  documentation, written with full knowledge, so it is never a check.
- **The model never writes the note** (G7). It names alternatives and tradeoffs in a few
  words each, never prose to paste in.
- **Not required for every line.** Builders document what they choose. Coverage just shows
  what's still undocumented.

---

## How it works

1. **Select lines in the code view, and write a note.** It's stored with (repo, SHA, path,
   lines) and linked to any outcome sightings it overlaps. Pointers only, no code (G11).
2. **Tradeoff check.** The model receives the lines plus context, the outcome, and the note.
   It returns: whether a real alternative exists; the alternatives, each with lines; the
   tradeoffs, each with lines; and whether the note covers each. All short phrases, Zod
   validated (G16), under `TRADEOFF_PROMPT_VERSION`.
3. **Results:**
   - **No real alternative:** "nothing to add". No question.
   - **The note covers it:** ✓.
   - **The note misses it:** one follow-up question. The builder can add to the note
     (revisions are kept) or press "I disagree".
4. **Publishing:** each note has a **publish** choice for the profile (0012). Notes are
   private by default (product-direction §3.8).

If the model is unavailable or capped, the note is saved, and the check runs later.

## Deliverables

**Schema**
- [ ] `notes` (user, repo, sha, path, lines, text, publish, created and updated), and
      `note_revisions`
- [ ] `note_checks` (note, prompt version, alternative exists, alternatives and tradeoffs with
      lines, covered flags, cache entry); `note_disagreements`

**Core** — `src/core/notes/`
- [ ] Create and revise notes; link them to overlapping sightings, so the outcome becomes
      documented
- [ ] Tradeoff check through `core/llm`, cached; a deferred retry when the model is unavailable

**Web and CLI**
- [ ] Code view: select lines → note → the check result → add to note, or disagree; a publish
      toggle
- [ ] Coverage shows "documented" per outcome, and lists what's undocumented

**Tests**
- [ ] The check against a fake model: no alternative gives no question; a missed tradeoff
      gives exactly one follow-up; a malformed result is rejected
- [ ] Revising a note keeps the earlier version; overlapping a sighting makes the outcome
      documented
- [ ] Copy check: no model prose in the note; the follow-up is a question, not an answer
- [ ] **Manual:** ten real notes. Are the alternatives real, and the "no real choice" verdicts
      right?

**Not deliverables, on purpose:** checks and the learned status (0011), the profile (0012).

## How we will know it worked

- **The builder adds to notes after a follow-up** more often than they disagree. If
  disagreements dominate, the model is finding alternatives that aren't real.
- **"No real alternative" is right** on the manual set.

**Honest risk:** a model telling you what the alternatives were can become a crutch: you
read its answer and paste the idea in. That is why notes never count as the explanation.
Only 0011's check, with no hints, does.

## Open questions

1. Can a note span several files (a decision implemented across a migration and a query)?
   v1 is one file and one range per note.
