/**
 * "Whose commits are these?" — asked once per identity, outside the weekly
 * budget (0003 §2). Shared by every command that attributes code: `ask`,
 * `goals` and `coverage`.
 */
import { loadIdentitySet, recordIdentity, unresolvedIdentities } from '../core/decisions/identity.js';
import type { LocalClone } from '../core/decisions/local.js';
import { authorIdentities, type Repo } from '../core/git/index.js';
import type { Session } from '../session.js';
import type { Prompter } from './prompt.js';

export async function identitySetup(
  session: Session,
  repo: Repo,
  clone: LocalClone,
  prompt: Prompter,
): Promise<void> {
  const known = await loadIdentitySet(session.db, session.userId);
  const unresolved = unresolvedIdentities(await authorIdentities(repo), known);
  if (unresolved.length === 0) return;

  console.log('\n  First, whose commits are these? Asked once per identity.\n');
  for (const identity of unresolved) {
    const answer = await prompt.choose(
      `  Who is ${JSON.stringify(identity.name)} <${identity.email}>?   ${identity.commits} commit${identity.commits === 1 ? '' : 's'} in ${clone.name}\n` +
        '    [m] Me   [o] Someone else   [l] Ask me later\n  > ',
      ['m', 'o', 'l'],
    );
    if (answer === null) return;
    if (answer === 'l') continue;
    await recordIdentity(session.db, session.userId, identity, answer === 'm' ? 'me' : 'other');
  }
}
