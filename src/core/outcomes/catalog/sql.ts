/**
 * SQL, broken into outcomes. Hand-written (0007). Each outcome is found in raw
 * SQL — `.sql` files and SQL strings in code — and, where an ORM has an
 * obvious equivalent, in ORM calls, labelled `via: 'orm'`. ORM use counts as
 * touching (builder's decision); the label keeps the difference visible.
 */
import { isCodeFile, matchingLines, sqlCode, sqlLines, toHits } from '../text.js';
import type { FileAtCommit, Hit, OutcomeDef, SkillDef } from '../types.js';

function sqlOutcome(def: {
  slug: string;
  name: string;
  description: string;
  sql: RegExp;
  orm?: RegExp;
  /** Path-based match, e.g. migration files. */
  path?: RegExp;
  /** SQL lines that match `sql` but are another outcome's, e.g. a partial index's WHERE. */
  except?: RegExp;
}): OutcomeDef {
  return {
    slug: def.slug,
    name: def.name,
    description: def.description,
    detect(file: FileAtCommit): Hit[] {
      const hits: Hit[] = [];
      const sql = sqlLines(file);
      if (def.path?.test(file.path) === true && sql.size > 0) {
        hits.push(...toHits([...sql], 'sql'));
      } else if (sql.size > 0) {
        const lines = matchingLines(file, def.sql, sql, sqlCode);
        const except = def.except;
        hits.push(...toHits(except === undefined ? lines : lines.filter((n) => !except.test(file.lines[n - 1] ?? '')), 'sql'));
      }
      if (def.orm !== undefined && isCodeFile(file.path)) {
        // Exclude lines already counted as SQL so one line isn't both.
        const orm = matchingLines(file, def.orm).filter((n) => !sql.has(n));
        hits.push(...toHits(orm, 'orm'));
      }
      return hits;
    },
  };
}

export const SQL: SkillDef = {
  slug: 'sql',
  name: 'SQL',
  kind: 'language',
  aliases: ['postgres', 'postgresql', 'mysql', 'sqlite', 'relational databases', 'databases'],
  outcomes: [
    sqlOutcome({
      slug: 'sql.filtering_sorting',
      name: 'Filtering and sorting',
      description: 'WHERE, ORDER BY, LIMIT',
      sql: /\b(WHERE|ORDER\s+BY|LIMIT)\b/i,
      // A partial index's WHERE is part of the index (sql.indexes), not a query filtering rows.
      except: /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i,
      orm: /\.(orderBy|limit)\(/,
    }),
    sqlOutcome({
      slug: 'sql.joins',
      name: 'Joins',
      description: 'INNER vs LEFT, joining tables on keys',
      sql: /\b((INNER|LEFT|RIGHT|FULL|CROSS)(\s+OUTER)?\s+)?JOIN\b/i,
      orm: /\.(innerJoin|leftJoin|rightJoin|fullJoin)\(/,
    }),
    sqlOutcome({
      slug: 'sql.aggregates',
      name: 'Aggregates',
      description: 'COUNT, SUM, AVG with GROUP BY',
      sql: /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(|\bGROUP\s+BY\b/i,
      orm: /\.groupBy\(/,
    }),
    sqlOutcome({
      slug: 'sql.having',
      name: 'HAVING',
      description: 'Filtering groups, not rows',
      sql: /\bHAVING\b/i,
      orm: /\.having\(/,
    }),
    sqlOutcome({
      slug: 'sql.subqueries_ctes',
      name: 'Subqueries and CTEs',
      description: 'A query inside a query, or WITH … AS',
      sql: /\(\s*SELECT\b|\bWITH\s+(RECURSIVE\s+)?\w+\s+AS\s*\(/i,
      orm: /\.\$with\(|\.with\(\s*\w+\s*\)\.select\(/,
    }),
    sqlOutcome({
      slug: 'sql.indexes',
      name: 'Indexes',
      description: 'CREATE INDEX, and when it helps',
      sql: /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i,
      orm: /\b(uniqueIndex|index)\(\s*['"`]|@@index\b/,
    }),
    sqlOutcome({
      slug: 'sql.constraints',
      name: 'Constraints',
      description: 'Foreign keys, UNIQUE, CHECK, primary keys',
      // Not `WITH CHECK (…)`: that's a row-level-security policy, not a
      // constraint (six of them in confetti-confectionery's first migration).
      sql: /\b(FOREIGN\s+KEY|REFERENCES|UNIQUE|PRIMARY\s+KEY)\b|(?<!\bWITH\s+)\bCHECK\s*\(/i,
      // Drizzle's check() is check('name', sql`…`). A bare check("…") is usually a
      // test helper: it matched 78 lines of one in confetti-confectionery.
      orm: /\.references\(|\.unique\(\)|\bcheck\(\s*['"`][\w-]+['"`]\s*,\s*sql`|@relation\b|@unique\b/,
    }),
    sqlOutcome({
      slug: 'sql.transactions',
      name: 'Transactions',
      description: 'BEGIN/COMMIT: all-or-nothing writes',
      sql: /\b(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT)\b/i,
      orm: /\.(transaction|\$transaction)\(/,
    }),
    sqlOutcome({
      slug: 'sql.upserts',
      name: 'Upserts',
      description: 'ON CONFLICT: insert or update in one statement',
      sql: /\bON\s+CONFLICT\b|\bON\s+DUPLICATE\s+KEY\b|\bMERGE\s+INTO\b/i,
      orm: /\.(onConflictDoUpdate|onConflictDoNothing|upsert)\(/,
    }),
    sqlOutcome({
      slug: 'sql.migrations',
      name: 'Migrations',
      description: 'Changing the schema in versioned steps',
      sql: /\b(CREATE|ALTER|DROP)\s+TABLE\b/i,
      path: /(^|\/)migrations?\//i,
    }),
    sqlOutcome({
      slug: 'sql.window_functions',
      name: 'Window functions',
      description: 'ROW_NUMBER, running totals: OVER (…)',
      sql: /\bOVER\s*\(/i,
    }),
  ],
};
