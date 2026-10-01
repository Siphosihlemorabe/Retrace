/**
 * The built-in outcome lists (0007). Code is the source of truth; the lists
 * are synced into `skills` / `skill_outcomes` so goals and sightings can
 * reference them by key (decision 1, chosen by the builder).
 */
import { overlapsAdded } from '../text.js';
import type { FileAtCommit, Hit, OutcomeDef, SkillDef } from '../types.js';
import { DOCKER } from './docker.js';
import { NODE_REST_API } from './node-rest-api.js';
import { SQL } from './sql.js';

/**
 * Bump whenever a detector changes what it matches, or an outcome is added or
 * removed. Stored on every sighting (G13).
 */
export const OUTCOMES_VERSION = 1;

export const BUILTIN_SKILLS: readonly SkillDef[] = [SQL, DOCKER, NODE_REST_API];

const normalise = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** A built-in skill by slug, name or alias ("Postgres" → SQL), or null. */
export function findBuiltinSkill(name: string): SkillDef | null {
  const n = normalise(name);
  return (
    BUILTIN_SKILLS.find(
      (s) => s.slug === n || normalise(s.name) === n || s.aliases.some((a) => normalise(a) === n),
    ) ?? null
  );
}

export interface OutcomeHit extends Hit {
  outcome: string;
}

/**
 * Every hit in a file for the given outcomes. For a commit scan, only hits
 * that include a line the commit added count — old code is never credited to
 * a new commit. For a snapshot scan (`added` empty) every hit counts.
 */
export function detectOutcomes(file: FileAtCommit, outcomes: readonly OutcomeDef[]): OutcomeHit[] {
  const snapshot = file.added.size === 0;
  const hits: OutcomeHit[] = [];
  for (const outcome of outcomes) {
    for (const hit of outcome.detect(file)) {
      if (snapshot || overlapsAdded(hit, file.added)) hits.push({ ...hit, outcome: outcome.slug });
    }
  }
  return hits;
}
