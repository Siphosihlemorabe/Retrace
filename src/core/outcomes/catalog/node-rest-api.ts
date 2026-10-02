/**
 * Node/REST APIs, broken into outcomes. Hand-written (0007). These read
 * ordinary JS/TS, so the rules are deliberately specific — a library name or a
 * framework call shape — to keep "touched" meaningful.
 */
import { isCodeFile, isTestFile, matchingLines, toHits } from '../text.js';
import type { FileAtCommit, Hit, OutcomeDef, SkillDef } from '../types.js';

/** Drops `//` line comments so words in comments never match. */
const code = (line: string) => line.replace(/(^|[^:])\/\/.*$/, '$1');

function codeRule(def: {
  slug: string;
  name: string;
  description: string;
  pattern: RegExp;
  onlyTests?: boolean;
}): OutcomeDef {
  return {
    slug: def.slug,
    name: def.name,
    description: def.description,
    ...(def.onlyTests === true ? { inTests: true } : {}),
    detect(file: FileAtCommit): Hit[] {
      if (!isCodeFile(file.path)) return [];
      if (def.onlyTests === true && !isTestFile(file.path)) return [];
      return toHits(matchingLines(file, def.pattern, undefined, code), 'code');
    },
  };
}

const ROUTER = String.raw`\b(app|router|server|api|fastify|hono|routes?)\.(get|post|put|patch|delete|all|route)\(`;

export const NODE_REST_API: SkillDef = {
  slug: 'node-rest-api',
  name: 'Node/REST APIs',
  kind: 'practice',
  aliases: ['rest', 'rest api', 'rest apis', 'node', 'nodejs', 'node.js', 'express', 'backend', 'apis'],
  outcomes: [
    codeRule({
      slug: 'node-rest-api.routing',
      name: 'Routing',
      description: 'Mapping methods and paths to handlers',
      pattern: new RegExp(`${ROUTER}\\s*['"\`]/`),
    }),
    codeRule({
      slug: 'node-rest-api.status_codes',
      name: 'Status codes beyond 200',
      description: '201, 204, 400, 404, 409, 500: saying what happened',
      pattern: /\.status\(\s*(201|202|204|3\d\d|4\d\d|5\d\d)\s*\)|\.sendStatus\(|\.code\(\s*(201|204|4\d\d|5\d\d)\s*\)|\.json\([^)]*,\s*(201|202|204|4\d\d|5\d\d)\s*\)/,
    }),
    codeRule({
      slug: 'node-rest-api.validation',
      name: 'Input validation',
      description: 'Checking request bodies before trusting them',
      // Parsing *request* input, not declaring a schema: a bare z.object in a
      // React form (frontend-fixer's Login.tsx) is client-side, not the API.
      pattern:
        /\.(safeParse|parse|validate)(Async)?\(\s*(await\s+)?(req|request|c\.req)\b|\b(zValidator|celebrate)\(|\bvalidator\(\s*['"](json|query|param|form)['"]/,
    }),
    codeRule({
      slug: 'node-rest-api.error_handling',
      name: 'Error-handling middleware',
      description: 'One place that turns errors into responses',
      pattern: /\(\s*err\w*\s*(:\s*\w+)?\s*,\s*req\w*\s*(:\s*\w+)?\s*,\s*res\w*\s*(:\s*\w+)?\s*,\s*next\w*|\.onError\(|setErrorHandler\(/,
    }),
    codeRule({
      slug: 'node-rest-api.authentication',
      name: 'Authentication',
      description: 'Who is calling: tokens, sessions, password hashing',
      pattern: /\bjwt\.(sign|verify)\(|from\s+['"](jsonwebtoken|bcrypt|bcryptjs|argon2|passport|express-session|lucia|jose)['"]|\b(requireAuth|isAuthenticated|authenticate)\b/,
    }),
    codeRule({
      slug: 'node-rest-api.pagination',
      name: 'Pagination',
      description: 'limit, offset or cursor instead of returning everything',
      // Both on one line, in either order: `const { limit } = req.query` reads
      // the request after naming the field.
      pattern:
        /^(?=.*(\breq\.query\b|\bc\.req\.query\(|\brequest\.query\b|\bsearchParams\b))(?=.*\b(limit|offset|cursor|page|pageSize|per_page)\b)|\.limit\([^)]*\)\s*\.offset\(/,
    }),
    codeRule({
      slug: 'node-rest-api.rate_limiting',
      name: 'Rate limiting',
      description: 'Protecting the API from too many requests',
      pattern: /from\s+['"](express-rate-limit|@fastify\/rate-limit|hono-rate-limiter|rate-limiter-flexible)['"]|\brateLimit\(/,
    }),
    codeRule({
      slug: 'node-rest-api.cors',
      name: 'CORS',
      description: 'Which other sites may call the API',
      pattern: /\bcors\(|from\s+['"](cors|@fastify\/cors|hono\/cors)['"]|Access-Control-Allow-Origin/,
    }),
    codeRule({
      slug: 'node-rest-api.logging',
      name: 'Structured logging',
      description: 'Logs a machine can search, not console.log',
      pattern: /from\s+['"](pino|winston|bunyan|morgan|pino-http)['"]|\blogger\.(info|warn|error|debug)\(/,
    }),
    codeRule({
      slug: 'node-rest-api.api_tests',
      name: 'API tests',
      description: 'Tests that call your endpoints',
      pattern: /from\s+['"]supertest['"]|\brequest\(\s*app\s*\)|\bapp\.request\(|\.inject\(\s*\{/,
      onlyTests: true,
    }),
  ],
};
