/**
 * Learning outcomes (0007): what a skill breaks into, and the rules that find
 * code touching each one. Pure types — no git, no database.
 */

/** A file as it is at one commit, with the lines that commit added. */
export interface FileAtCommit {
  path: string;
  /** Full content at the commit, split into lines (index 0 is line 1). */
  lines: readonly string[];
  /** 1-based numbers of the lines this commit added. Empty for a snapshot scan. */
  added: ReadonlySet<number>;
}

/** How the code touched the outcome — kept so "via an ORM" stays visible. */
export type Via = 'sql' | 'orm' | 'config' | 'code';

/** A 1-based, inclusive range of lines that touches an outcome. */
export interface Hit {
  start: number;
  end: number;
  via: Via;
}

export interface OutcomeDef {
  /** Unique across skills: `sql.joins`. */
  slug: string;
  name: string;
  /** One line, shown when ticking the objective. */
  description: string;
  /** Every place in the file that touches this outcome. Overlap with `added` is applied by the caller. */
  detect: (file: FileAtCommit) => Hit[];
}

export interface SkillDef {
  slug: string;
  name: string;
  /** Matches `skills.kind`. */
  kind: 'technology' | 'language' | 'concept' | 'practice';
  /** Other names the builder might type: "postgres" → sql. */
  aliases: readonly string[];
  outcomes: readonly OutcomeDef[];
}
