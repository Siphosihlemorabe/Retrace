/**
 * Every built-in outcome against at least one snippet it must match and one it
 * must not. The negatives are the point: "touched" is shown as fact, so a
 * detector that fires on `Array.prototype.join` or a comment overstates the
 * builder.
 */
import { describe, expect, test } from 'vitest';

import type { FileAtCommit, Via } from '../types.js';
import { BUILTIN_SKILLS, detectOutcomes, findBuiltinSkill } from './index.js';

const file = (path: string, content: string, added?: number[]): FileAtCommit => ({
  path,
  lines: content.split('\n'),
  added: new Set(added ?? []),
});

const ALL = BUILTIN_SKILLS.flatMap((s) => s.outcomes);
const hitsFor = (slug: string, f: FileAtCommit) =>
  detectOutcomes(f, ALL.filter((o) => o.slug === slug));

interface Case {
  outcome: string;
  path: string;
  content: string;
  /** Expected `via` of the first hit, or false for "must not match". */
  expect: Via | false;
  why?: string;
}

const CASES: Case[] = [
  // --- SQL -------------------------------------------------------------------
  { outcome: 'sql.filtering_sorting', path: 'q.sql', content: 'SELECT * FROM t WHERE id = 1 ORDER BY id;', expect: 'sql' },
  { outcome: 'sql.filtering_sorting', path: 'q.sql', content: '-- where should this go?', expect: false, why: 'comment' },
  { outcome: 'sql.joins', path: 'db/queries.sql', content: 'SELECT b.id\nFROM bookings b\nLEFT JOIN customers c ON c.id = b.customer_id;', expect: 'sql' },
  { outcome: 'sql.joins', path: 'src/q.ts', content: 'const rows = await db.query(`\n  SELECT b.id FROM bookings b\n  INNER JOIN customers c ON c.id = b.cid\n`);', expect: 'sql', why: 'multi-line template' },
  { outcome: 'sql.joins', path: 'src/q.ts', content: "db.select().from(bookings).leftJoin(customers, eq(customers.id, bookings.customerId));", expect: 'orm' },
  { outcome: 'sql.joins', path: 'src/util.ts', content: "const csv = parts.join(', ');", expect: false, why: 'Array.prototype.join' },
  { outcome: 'sql.joins', path: 'src/util.ts', content: '// we join the arrays later', expect: false, why: 'comment' },
  { outcome: 'sql.joins', path: 'src/ui.tsx', content: 'const label = `Join ${name} today`;', expect: false, why: 'prose in a template' },
  { outcome: 'sql.aggregates', path: 'r.sql', content: 'SELECT status, COUNT(*) FROM orders GROUP BY status;', expect: 'sql' },
  { outcome: 'sql.aggregates', path: 'src/r.ts', content: 'db.select({ n: count() }).from(t).groupBy(t.status);', expect: 'orm' },
  { outcome: 'sql.aggregates', path: 'src/r.ts', content: 'const total = items.length;', expect: false },
  { outcome: 'sql.having', path: 'r.sql', content: 'SELECT c, COUNT(*) FROM t GROUP BY c HAVING COUNT(*) > 1;', expect: 'sql' },
  { outcome: 'sql.having', path: 'r.sql', content: 'SELECT c FROM t GROUP BY c;', expect: false },
  { outcome: 'sql.subqueries_ctes', path: 'r.sql', content: 'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent;', expect: 'sql' },
  { outcome: 'sql.subqueries_ctes', path: 'r.sql', content: 'SELECT * FROM t WHERE id IN (SELECT id FROM u);', expect: 'sql' },
  { outcome: 'sql.subqueries_ctes', path: 'r.sql', content: 'SELECT * FROM t;', expect: false },
  { outcome: 'sql.indexes', path: 'm.sql', content: 'CREATE INDEX bookings_customer_idx ON bookings (customer_id);', expect: 'sql' },
  { outcome: 'sql.indexes', path: 'src/db/schema.ts', content: "index('bookings_customer_idx').on(t.customerId),", expect: 'orm' },
  { outcome: 'sql.indexes', path: 'src/list.ts', content: 'const i = list.indexOf(x);', expect: false },
  { outcome: 'sql.constraints', path: 'm.sql', content: 'customer_id uuid REFERENCES customers(id),', expect: 'sql' },
  { outcome: 'sql.constraints', path: 'src/db/schema.ts', content: '.references(() => users.id, { onDelete: "cascade" })', expect: 'orm' },
  { outcome: 'sql.constraints', path: 'm.sql', content: 'name text NOT NULL,', expect: false },
  { outcome: 'sql.constraints', path: 'src/db/schema.ts', content: "check('orders_total', sql`${t.total} >= 0`),", expect: 'orm' },
  { outcome: 'sql.constraints', path: 'm.sql', content: 'qty int not null check (qty > 0),', expect: 'sql' },
  { outcome: 'sql.constraints', path: 'm.sql', content: 'for update to authenticated using (true) with check (true);', expect: false, why: 'RLS policy, not a constraint (found in confetti)' },
  { outcome: 'sql.constraints', path: 'scripts/smoke.mjs', content: 'check("POST status → 401", res.status === 401);', expect: false, why: 'a test helper named check (found in confetti)' },
  { outcome: 'sql.transactions', path: 'm.sql', content: 'BEGIN;\nUPDATE a SET x = 1;\nCOMMIT;', expect: 'sql' },
  { outcome: 'sql.transactions', path: 'src/pay.ts', content: 'await db.transaction(async (tx) => {', expect: 'orm' },
  { outcome: 'sql.transactions', path: 'src/ui.ts', content: "const msg = 'Begin your journey';", expect: false, why: 'prose' },
  { outcome: 'sql.upserts', path: 'q.sql', content: 'INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO NOTHING;', expect: 'sql' },
  { outcome: 'sql.upserts', path: 'src/q.ts', content: '.onConflictDoUpdate({ target: t.id, set: { n: 1 } })', expect: 'orm' },
  { outcome: 'sql.upserts', path: 'q.sql', content: 'INSERT INTO t (id) VALUES (1);', expect: false },
  { outcome: 'sql.migrations', path: 'migrations/0002_add_orders.sql', content: 'ALTER TABLE orders ADD COLUMN paid boolean;', expect: 'sql' },
  { outcome: 'sql.migrations', path: 'src/q.ts', content: 'const x = 1;', expect: false },
  { outcome: 'sql.window_functions', path: 'r.sql', content: 'SELECT ROW_NUMBER() OVER (PARTITION BY c ORDER BY t) FROM x;', expect: 'sql' },
  { outcome: 'sql.window_functions', path: 'r.sql', content: 'SELECT * FROM x;', expect: false },

  // --- Docker ----------------------------------------------------------------
  { outcome: 'docker.dockerfile', path: 'Dockerfile', content: 'FROM node:22-alpine\nCMD ["node", "dist/index.js"]', expect: 'config' },
  { outcome: 'docker.dockerfile', path: 'README.md', content: 'FROM node:22', expect: false, why: 'not a Dockerfile' },
  { outcome: 'docker.pinned_base_image', path: 'Dockerfile', content: 'FROM node:22.11-alpine', expect: 'config' },
  { outcome: 'docker.pinned_base_image', path: 'Dockerfile', content: 'FROM node:latest', expect: false },
  { outcome: 'docker.pinned_base_image', path: 'Dockerfile', content: 'FROM node', expect: false, why: 'no tag means latest' },
  { outcome: 'docker.multi_stage', path: 'Dockerfile', content: 'FROM node:22 AS build\nRUN npm run build\nFROM node:22-slim\nCOPY --from=build /app/dist ./dist', expect: 'config' },
  { outcome: 'docker.multi_stage', path: 'Dockerfile', content: 'FROM node:22\nRUN npm ci', expect: false },
  { outcome: 'docker.layer_caching', path: 'Dockerfile', content: 'FROM node:22\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .', expect: 'config' },
  { outcome: 'docker.layer_caching', path: 'Dockerfile', content: 'FROM node:22\nCOPY . .\nRUN npm ci', expect: false, why: 'source copied before install' },
  { outcome: 'docker.non_root_user', path: 'Dockerfile', content: 'USER node', expect: 'config' },
  { outcome: 'docker.non_root_user', path: 'Dockerfile', content: 'USER root', expect: false },
  { outcome: 'docker.dockerignore', path: '.dockerignore', content: 'node_modules\n.env', expect: 'config' },
  { outcome: 'docker.dockerignore', path: '.gitignore', content: 'node_modules', expect: false },
  { outcome: 'docker.healthcheck', path: 'Dockerfile', content: 'HEALTHCHECK CMD curl -f http://localhost:3000/ || exit 1', expect: 'config' },
  { outcome: 'docker.healthcheck', path: 'compose.yaml', content: 'services:\n  api:\n    healthcheck:\n      test: ["CMD", "true"]', expect: 'config' },
  { outcome: 'docker.healthcheck', path: 'Dockerfile', content: '# TODO: HEALTHCHECK', expect: false, why: 'comment' },
  { outcome: 'docker.compose_services', path: 'docker-compose.yml', content: 'services:\n  db:\n    image: postgres:16', expect: 'config' },
  { outcome: 'docker.compose_services', path: 'config.yml', content: 'services:\n  - a', expect: false, why: 'not a compose file' },
  { outcome: 'docker.volumes', path: 'compose.yml', content: 'services:\n  db:\n    volumes:\n      - pg:/var/lib/postgresql/data', expect: 'config' },
  { outcome: 'docker.volumes', path: 'Dockerfile', content: 'FROM node:22', expect: false },
  { outcome: 'docker.env_and_secrets', path: 'Dockerfile', content: 'ARG NODE_ENV=production\nENV PORT=3000', expect: 'config' },
  { outcome: 'docker.env_and_secrets', path: 'Dockerfile', content: 'RUN npm ci', expect: false },
  { outcome: 'docker.ports_networking', path: 'Dockerfile', content: 'EXPOSE 3000', expect: 'config' },
  { outcome: 'docker.ports_networking', path: 'compose.yml', content: 'services:\n  api:\n    ports:\n      - "3000:3000"', expect: 'config' },
  { outcome: 'docker.ports_networking', path: 'Dockerfile', content: 'RUN echo expose', expect: false },

  // --- Node/REST APIs --------------------------------------------------------
  { outcome: 'node-rest-api.routing', path: 'src/server.ts', content: "app.get('/bookings', listBookings);", expect: 'code' },
  { outcome: 'node-rest-api.routing', path: 'src/map.ts', content: 'const v = cache.get(key);', expect: false, why: 'Map.get, not a route' },
  { outcome: 'node-rest-api.status_codes', path: 'src/server.ts', content: 'res.status(404).json({ error: "not found" });', expect: 'code' },
  { outcome: 'node-rest-api.status_codes', path: 'src/hono.ts', content: "return c.json({ id }, 201);", expect: 'code' },
  { outcome: 'node-rest-api.status_codes', path: 'src/server.ts', content: 'res.status(200).json(rows);', expect: false, why: '200 is the default' },
  { outcome: 'node-rest-api.validation', path: 'src/routes.ts', content: 'const Body = z.object({ name: z.string() });\nconst body = Body.parse(req.body);', expect: 'code' },
  { outcome: 'node-rest-api.validation', path: 'src/routes.ts', content: 'const body = req.body;', expect: false },
  { outcome: 'node-rest-api.validation', path: 'src/hono.ts', content: "app.post('/x', zValidator('json', Body), handler);", expect: 'code' },
  { outcome: 'node-rest-api.validation', path: 'src/pages/Login.tsx', content: 'const schema = z.object({ email: z.string().email() });', expect: false, why: 'client-side form schema (found in frontend-fixer)' },
  { outcome: 'node-rest-api.error_handling', path: 'src/server.ts', content: 'app.use((err, req, res, next) => {', expect: 'code' },
  { outcome: 'node-rest-api.error_handling', path: 'src/app.ts', content: 'app.onError((error, c) => c.json({ error: "x" }, 500));', expect: 'code' },
  { outcome: 'node-rest-api.error_handling', path: 'src/server.ts', content: 'app.use((req, res, next) => next());', expect: false },
  { outcome: 'node-rest-api.authentication', path: 'src/auth.ts', content: "import jwt from 'jsonwebtoken';\nconst token = jwt.sign(payload, secret);", expect: 'code' },
  { outcome: 'node-rest-api.authentication', path: 'src/auth.ts', content: "const author = 'me';", expect: false },
  { outcome: 'node-rest-api.pagination', path: 'src/routes.ts', content: 'const { limit, offset } = req.query;', expect: 'code' },
  { outcome: 'node-rest-api.pagination', path: 'src/ui.ts', content: 'const page = 1;', expect: false, why: 'not reading a request' },
  { outcome: 'node-rest-api.rate_limiting', path: 'src/server.ts', content: "import rateLimit from 'express-rate-limit';", expect: 'code' },
  { outcome: 'node-rest-api.rate_limiting', path: 'src/server.ts', content: 'const rate = 0.2;', expect: false },
  { outcome: 'node-rest-api.cors', path: 'src/server.ts', content: "import cors from 'cors';\napp.use(cors());", expect: 'code' },
  { outcome: 'node-rest-api.cors', path: 'src/server.ts', content: '// TODO cors()', expect: false, why: 'comment' },
  { outcome: 'node-rest-api.logging', path: 'src/log.ts', content: "import pino from 'pino';", expect: 'code' },
  { outcome: 'node-rest-api.logging', path: 'src/log.ts', content: "console.log('hi');", expect: false },
  { outcome: 'node-rest-api.api_tests', path: 'src/api.test.ts', content: "import request from 'supertest';\nawait request(app).get('/x');", expect: 'code' },
  { outcome: 'node-rest-api.api_tests', path: 'src/api.ts', content: "await request(app).get('/x');", expect: false, why: 'not a test file' },
];

describe('every built-in outcome has a positive and a negative fixture', () => {
  test.each(ALL.map((o) => o.slug))('%s', (slug) => {
    const cases = CASES.filter((c) => c.outcome === slug);
    expect(cases.some((c) => c.expect !== false), `${slug} needs a positive`).toBe(true);
    expect(cases.some((c) => c.expect === false), `${slug} needs a negative`).toBe(true);
  });
});

describe('detectors', () => {
  test.each(CASES)('$outcome · $path · $why', ({ outcome, path, content, expect: want }) => {
    const hits = hitsFor(outcome, file(path, content));
    if (want === false) expect(hits).toEqual([]);
    else expect(hits[0]?.via).toBe(want);
  });
});

describe('commit scans credit only what the commit added', () => {
  const sql = 'SELECT b.id\nFROM bookings b\nLEFT JOIN customers c ON c.id = b.cid;';

  test('a hit is kept when it includes an added line', () => {
    expect(hitsFor('sql.joins', file('q.sql', sql, [3]))).toHaveLength(1);
  });

  test('old code is not credited to a commit that only touched other lines', () => {
    expect(hitsFor('sql.joins', file('q.sql', sql, [1]))).toEqual([]);
  });

  test('a whole-file outcome (multi-stage) counts when the commit added one of its lines', () => {
    const df = 'FROM node:22 AS build\nRUN npm run build\nFROM node:22-slim';
    expect(hitsFor('docker.multi_stage', file('Dockerfile', df, [3]))).toHaveLength(1);
    expect(hitsFor('docker.multi_stage', file('Dockerfile', df, [2]))).toEqual([]);
  });
});

describe('skills by name', () => {
  test.each([
    ['SQL', 'sql'],
    ['postgres', 'sql'],
    ['Docker', 'docker'],
    ['Node.js', 'node-rest-api'],
    ['REST API', 'node-rest-api'],
  ])('%s → %s', (name, slug) => {
    expect(findBuiltinSkill(name)?.slug).toBe(slug);
  });

  test('anything else is not built in (it gets a model-drafted list in 0009)', () => {
    expect(findBuiltinSkill('Redis')).toBeNull();
  });

  test('outcome slugs are unique and prefixed by their skill', () => {
    const slugs = BUILTIN_SKILLS.flatMap((s) => s.outcomes.map((o) => o.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of BUILTIN_SKILLS) for (const o of s.outcomes) expect(o.slug.startsWith(`${s.slug}.`)).toBe(true);
  });
});
