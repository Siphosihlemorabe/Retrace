/**
 * Outcome lists for skills without a built-in one (0009 §3). A model drafts
 * the list from the skill's name alone (no code is sent), the builder edits it,
 * and only the list they save is ever used.
 */
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';

import { learningGoals, skillOutcomes, skills } from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import { completeJson, providerFromEnv, type JsonResult, type Provider } from '../llm/index.js';
import { setObjective } from './goals.js';

export const OUTCOME_DRAFT_VERSION = 1;

export const OUTCOME_DRAFT_SYSTEM = `You break a skill a developer wants to learn into learning outcomes they could show in their own code.

You are given the skill's name. List 6 to 12 outcomes, from foundational to advanced. Each outcome:
- is something a developer does in code, not something they read about
- has a short name (under 6 words)
- has a one-line description of what doing it well looks like (under 20 words)
- has 1 to 8 "lookFor" cues: literal text that appears in source code or config when the outcome is touched, such as a function name, a keyword, or an option. Each cue is at least 3 characters and is matched case-insensitively as a substring, so avoid cues that would match ordinary code.

Do not teach, explain, or give examples beyond the cues.

Reply with JSON only, in exactly this shape:
{"outcomes":[{"name":"…","description":"…","lookFor":["…"]}]}`;

const Cue = z.string().trim().min(3).max(40);

export const DraftOutcome = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().min(5).max(160),
  lookFor: z.array(Cue).min(1).max(8),
});
export type DraftOutcome = z.infer<typeof DraftOutcome>;

export const DraftOutput = z.object({ outcomes: z.array(DraftOutcome).min(6).max(12) });

/** A draft for the builder to review. Nothing is saved. */
export async function draftOutcomes(
  db: Db,
  userId: string,
  skillName: string,
  provider: Provider | null = providerFromEnv(),
): Promise<JsonResult<z.infer<typeof DraftOutput>>> {
  if (provider === null) return { ok: false, reason: 'off', message: 'No model is connected.' };
  return completeJson(
    db,
    userId,
    {
      purpose: 'outcomes:draft',
      promptVersion: OUTCOME_DRAFT_VERSION,
      system: OUTCOME_DRAFT_SYSTEM,
      input: `Skill: ${skillName.trim()}`,
      schema: DraftOutput,
      cacheParts: [skillName.trim().toLowerCase()],
    },
    provider,
  );
}

const slugPart = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export interface ReviewedOutcome extends DraftOutcome {
  /** Present when editing an outcome already saved; keeps its sightings attached. */
  slug?: string;
}

/**
 * Save the builder's reviewed list for a skill. Outcomes left out are retired,
 * not deleted, so sightings that point at them still resolve. New outcomes join
 * the objective of every goal already set for this skill, as "all" does when a
 * goal is set; the builder can untick them.
 */
export async function saveOutcomeList(
  db: Db,
  skillId: string,
  list: readonly ReviewedOutcome[],
): Promise<{ slugs: string[]; added: number; retired: number }> {
  const items = list.map((o) => ({ ...DraftOutcome.parse(o), slug: o.slug }));
  if (items.length === 0) throw new Error('A list needs at least one outcome.');

  const [skill] = await db.select({ slug: skills.slug }).from(skills).where(eq(skills.id, skillId));
  if (skill === undefined) throw new Error('No such skill.');
  const [builtin] = await db
    .select({ id: skillOutcomes.id })
    .from(skillOutcomes)
    .where(and(eq(skillOutcomes.skillId, skillId), eq(skillOutcomes.source, 'builtin')))
    .limit(1);
  if (builtin !== undefined) throw new Error('This skill has a built-in list.');

  const added: string[] = [];
  const slugs: string[] = [];
  const retired = await db.transaction(async (tx) => {
    const existing = new Set(
      (await tx.select({ slug: skillOutcomes.slug }).from(skillOutcomes).where(eq(skillOutcomes.skillId, skillId))).map((r) => r.slug),
    );
    const taken = new Set<string>();
    for (const [ordinal, o] of items.entries()) {
      let slug = o.slug ?? `${skill.slug}.${slugPart(o.name) || 'outcome'}`;
      if (!slug.startsWith(`${skill.slug}.`)) throw new Error(`${slug} is not an outcome of this skill.`);
      for (let n = 2; taken.has(slug); n += 1) slug = `${skill.slug}.${slugPart(o.name)}-${n}`;
      taken.add(slug);
      slugs.push(slug);

      const [row] = await tx
        .insert(skillOutcomes)
        .values({ skillId, slug, name: o.name, description: o.description, ordinal, source: 'model_reviewed', lookFor: o.lookFor })
        .onConflictDoUpdate({
          target: skillOutcomes.slug,
          set: { name: o.name, description: o.description, ordinal, lookFor: o.lookFor, retiredAt: null },
        })
        .returning({ id: skillOutcomes.id });
      if (row === undefined) throw new Error(`could not save ${o.name}`);
      if (!existing.has(slug)) added.push(row.id);
    }
    const gone = await tx
      .update(skillOutcomes)
      .set({ retiredAt: new Date() })
      .where(and(eq(skillOutcomes.skillId, skillId), notInArray(skillOutcomes.slug, slugs), isNull(skillOutcomes.retiredAt)))
      .returning({ id: skillOutcomes.id });
    return gone.length;
  });

  const goals = await db
    .select({ id: learningGoals.id })
    .from(learningGoals)
    .where(and(eq(learningGoals.skillId, skillId), eq(learningGoals.kind, 'intent')));
  for (const g of goals) for (const outcomeId of added) await setObjective({ db }, g.id, outcomeId, true);

  return { slugs, added: added.length, retired };
}
