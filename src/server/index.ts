/**
 * `npm run ui` — the local web UI (0006): the API, plus the built web app
 * from web/dist, on http://127.0.0.1:PORT.
 *
 * Listens on 127.0.0.1 only. There is no sign-in; reaching this server means
 * acting as the builder, so nothing but this machine may reach it.
 */
import { existsSync } from 'node:fs';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

import { openSession, SetupError } from '../session.js';
import { createApp } from './app.js';

const HOST = '127.0.0.1';
const WEB_DIST = './web/dist';

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 3000);
  const session = await openSession();
  const app = createApp({
    db: session.db,
    userId: session.userId,
    login: process.env['RETRACE_GITHUB_LOGIN'] ?? '',
  });

  if (existsSync(WEB_DIST)) {
    app.use('/*', serveStatic({ root: WEB_DIST }));
    app.get('/', serveStatic({ path: `${WEB_DIST}/index.html` }));
  } else {
    app.get('/', (c) => c.text('API is running. Build the web app with `npm run build:web`, or use `npm run ui`.'));
  }

  const server = serve({ fetch: app.fetch, hostname: HOST, port }, (info) => {
    console.log(`\n  Retrace is running at http://${HOST}:${info.port}\n  (Ctrl+C to stop)\n`);
  });

  const stop = () => {
    server.close();
    void session.end().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof SetupError ? error.message : error);
  process.exit(1);
});
