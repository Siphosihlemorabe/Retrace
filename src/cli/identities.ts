/**
 * `npm run identities` — which git identities are yours, and correcting them.
 *
 *   npm run identities                      list
 *   npm run identities -- --me <email>      this one is mine
 *   npm run identities -- --not-me <email>  this one is someone else's
 *
 * A correction moves the email across in one step; it is never both.
 */
import { parseArgs } from 'node:util';

import { eq } from 'drizzle-orm';

import { recordIdentity } from '../core/decisions/identity.js';
import { knownOtherIdentities, userGitIdentities } from '../db/schema.js';
import { openSession, SetupError } from '../session.js';

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { me: { type: 'string' }, 'not-me': { type: 'string' } },
  });
  const session = await openSession();
  try {
    if (values.me !== undefined) {
      await recordIdentity(session.db, session.userId, { email: values.me, name: '' }, 'me');
    }
    if (values['not-me'] !== undefined) {
      await recordIdentity(session.db, session.userId, { email: values['not-me'], name: '' }, 'other');
    }

    const [mine, others] = await Promise.all([
      session.db.select().from(userGitIdentities).where(eq(userGitIdentities.userId, session.userId)),
      session.db.select().from(knownOtherIdentities).where(eq(knownOtherIdentities.userId, session.userId)),
    ]);
    console.log('\n  Yours:');
    for (const i of mine) console.log(`    ${i.email}  (${i.confirmedVia.replace('_', ' ')})`);
    if (mine.length === 0) console.log('    none yet');
    console.log('\n  Someone else:');
    for (const i of others) console.log(`    ${i.email}${i.name ? `  ${i.name}` : ''}`);
    if (others.length === 0) console.log('    none yet');
    console.log('');
    return 0;
  } finally {
    await session.end();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof SetupError ? error.message : error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
