/**
 * The local server has no sign-in (0006): anyone who can reach it acts as the
 * builder. So it must be reachable only from this machine, and only by pages
 * the builder opened.
 *
 * - Listening on 127.0.0.1 keeps other machines out (see index.ts).
 * - The Host check stops DNS rebinding: a hostile page cannot point its own
 *   domain at 127.0.0.1 and talk to this server as a same-origin site.
 * - JSON-only writes stop cross-site form posts: a form can send
 *   urlencoded or multipart, never application/json, and a cross-origin fetch
 *   with a JSON body needs a CORS preflight this server never answers.
 */
import type { MiddlewareHandler } from 'hono';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const localOnly: MiddlewareHandler = async (c, next) => {
  const host = c.req.header('host') ?? '';
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!LOCAL_HOSTS.has(hostname ?? '')) {
    return c.json({ error: 'This server only answers on 127.0.0.1 or localhost.' }, 403);
  }

  if (WRITES.has(c.req.method)) {
    const type = c.req.header('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'Writes must be sent as application/json.' }, 415);
    }
  }
  await next();
};
