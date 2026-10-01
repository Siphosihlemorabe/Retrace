/**
 * The built-in catalogue in code → `skills`, `skill_aliases`, `skill_outcomes`
 * (0007 decision 1: code is the source of truth, synced so goals and sightings
 * can reference outcomes by key). Idempotent; runs before goals are read.
 */
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';

import { skillAliases, skillOutcomes, skills } from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import { BUILTIN_SKILLS, findBuiltinSkill } from './catalog/index.js';

export async function syncCatalogue(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    for (const skill of BUILTIN_SKILLS) {
      const [row] = await tx
        .insert(skills)
        .values({ slug: skill.slug, name: skill.name, kind: skill.kind })
        .onConflictDoUpdate({ target: skills.slug, set: { name: skill.name, kind: skill.kind } })
        .returning({ id: skills.id });
      if (row === undefined) throw new Error(`could not sync skill ${skill.slug}`);

      for (const alias of [skill.slug, skill.name, ...skill.aliases]) {
        await tx.insert(skillAliases).values({ skillId: row.id, alias }).onConflictDoNothing();
      }

      for (const [ordinal, o] of skill.outcomes.entries()) {
        await tx
          .insert(skillOutcomes)
          .values({ skillId: row.id, slug: o.slug, name: o.name, description: o.description, ordinal, source: 'builtin' })
          .onConflictDoUpdate({
            target: skillOutcomes.slug,
            set: { name: o.name, description: o.description, ordinal, retiredAt: null },
          });
      }

      // An outcome removed from code is retired, not deleted: sightings and
      // objectives that point at it still resolve, and history stays readable.
      const slugs = skill.outcomes.map((o) => o.slug);
      await tx
        .update(skillOutcomes)
        .set({ retiredAt: new Date() })
        .where(
          and(
            eq(skillOutcomes.skillId, row.id),
            eq(skillOutcomes.source, 'builtin'),
            notInArray(skillOutcomes.slug, slugs),
            isNull(skillOutcomes.retiredAt),
          ),
        );
    }
  });
}

export interface SkillRef {
  id: string;
  slug: string;
  name: string;
  builtin: boolean;
}

const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * The skill a goal is for. Built-in names and aliases ("postgres") resolve to
 * their skill; anything else becomes a skill of its own with no outcome list
 * yet. Its list is drafted by a model and reviewed by the builder (0009).
 *
 * `skills.kind` is required, and a custom skill's kind is not known. It is
 * stored as 'technology' until the taxonomy question in CLAUDE.md is settled.
 */
export async function resolveSkill(db: Db, name: string): Promise<SkillRef> {
  const builtin = findBuiltinSkill(name);
  if (builtin !== null) {
    const [row] = await db.select({ id: skills.id }).from(skills).where(eq(skills.slug, builtin.slug));
    if (row === undefined) throw new Error('catalogue not synced; call syncCatalogue first');
    return { id: row.id, slug: builtin.slug, name: builtin.name, builtin: true };
  }

  const [alias] = await db
    .select({ id: skills.id, slug: skills.slug, name: skills.name })
    .from(skillAliases)
    .innerJoin(skills, eq(skills.id, skillAliases.skillId))
    .where(eq(skillAliases.alias, name.trim()));
  if (alias !== undefined) return { ...alias, builtin: false };

  const slug = slugify(name);
  if (slug === '') throw new Error('a skill needs a name');
  const [row] = await db
    .insert(skills)
    .values({ slug, name: name.trim(), kind: 'technology' })
    .onConflictDoUpdate({ target: skills.slug, set: { slug } })
    .returning({ id: skills.id, slug: skills.slug, name: skills.name });
  if (row === undefined) throw new Error(`could not create skill ${name}`);
  await db.insert(skillAliases).values({ skillId: row.id, alias: name.trim() }).onConflictDoNothing();
  return { ...row, builtin: false };
}

/** A skill's live outcomes, in list order. */
export async function outcomesOf(db: Db, skillIds: readonly string[]) {
  if (skillIds.length === 0) return [];
  return db
    .select()
    .from(skillOutcomes)
    .where(and(inArray(skillOutcomes.skillId, [...skillIds]), isNull(skillOutcomes.retiredAt)))
    .orderBy(skillOutcomes.skillId, skillOutcomes.ordinal);
}
