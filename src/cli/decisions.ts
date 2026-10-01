/**
 * `npm run decisions` — what has been recorded, and what each record is still
 * missing. The gaps are the feedback; nothing is refused for being incomplete.
 */
import { listDecisions, missingParts } from '../core/decisions/list.js';
import { openSession, SetupError } from './session.js';

const ROLE = { made: 'you made it', directed: 'you directed it', kept: "you kept your agent's choice" } as const;

async function main(): Promise<number> {
  const session = await openSession();
  try {
    const records = await listDecisions(session.db, session.userId);
    if (records.length === 0) {
      console.log('\n  Nothing recorded yet. `npm run ask <repo>` to start.\n');
      return 0;
    }
    console.log('');
    for (const d of records) {
      const where = [d.repoName, d.anchorSha?.slice(0, 7), d.anchorPath].filter(Boolean).join(' · ');
      console.log(`  ${d.choice ?? '(no choice written)'}`);
      console.log(`    ${ROLE[d.role as keyof typeof ROLE] ?? d.role} · ${d.origin.replaceAll('_', ' ')}${where ? ` · ${where}` : ''}`);
      if (d.cost) console.log(`    cost: ${d.cost}`);
      const missing = missingParts(d);
      console.log(missing.length === 0 ? '    complete' : `    missing: ${missing.join(', ')}`);
      console.log('');
    }
    return 0;
  } finally {
    await session.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof SetupError ? error.message : error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
