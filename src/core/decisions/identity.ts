/**
 * Which git identities are the builder's (0003 §2).
 *
 * Asked once per identity, outside the weekly budget (G6): it is setup, and
 * without it every question after it is framed wrong. A commit counts as the
 * builder's only when its email is one they confirmed (G12) — an unknown
 * author is `unknown`, never assumed to be them.
 */
import { and, eq } from 'drizzle-orm';

import { knownOtherIdentities, userGitIdentities } from '../../db/schema.js';
import type { Db } from '../../db/types.js';
import type { AuthorIdentity } from '../git/index.js';
import { knownNonHuman, type IdentitySet } from '../detect/authorship.js';

export type IdentityVerdict = 'me' | 'other';

export async function loadIdentitySet(db: Db, userId: string): Promise<IdentitySet> {
  const [mine, others] = await Promise.all([
    db
      .select({ email: userGitIdentities.email })
      .from(userGitIdentities)
      .where(eq(userGitIdentities.userId, userId)),
    db
      .select({ email: knownOtherIdentities.email })
      .from(knownOtherIdentities)
      .where(eq(knownOtherIdentities.userId, userId)),
  ]);
  return {
    mine: new Set(mine.map((r) => r.email.toLowerCase())),
    others: new Set(others.map((r) => r.email.toLowerCase())),
  };
}

/**
 * Identities still to ask about, most commits first. Agents, bots and
 * templates the catalogues already recognise are not asked: "is
 * gpt-engineer-app[bot] you?" is the kind of question that makes the product
 * look like it isn't paying attention.
 */
export function unresolvedIdentities(
  identities: readonly AuthorIdentity[],
  known: IdentitySet,
): AuthorIdentity[] {
  return identities.filter(
    (i) =>
      !known.mine.has(i.email) &&
      !known.others.has(i.email) &&
      knownNonHuman(i.name, i.email) === null,
  );
}

/**
 * Record an answer, or correct an earlier one. One transaction: an email is
 * never both "me" and "not me" at once.
 */
export async function recordIdentity(
  db: Db,
  userId: string,
  identity: { email: string; name: string },
  verdict: IdentityVerdict,
): Promise<void> {
  const email = identity.email.trim().toLowerCase();

  await db.transaction(async (tx) => {
    if (verdict === 'me') {
      await tx
        .delete(knownOtherIdentities)
        .where(and(eq(knownOtherIdentities.userId, userId), eq(knownOtherIdentities.email, email)));
      await tx
        .insert(userGitIdentities)
        .values({ userId, email, confirmedVia: 'user_asserted' })
        .onConflictDoNothing({ target: userGitIdentities.email });

      // The email is globally unique: if it already belongs to someone else,
      // saying "me" must fail loudly, not silently leave it with them.
      const [owner] = await tx
        .select({ userId: userGitIdentities.userId })
        .from(userGitIdentities)
        .where(eq(userGitIdentities.email, email));
      if (owner?.userId !== userId) {
        throw new Error(`${email} is already claimed by another user`);
      }
    } else {
      await tx
        .delete(userGitIdentities)
        .where(and(eq(userGitIdentities.userId, userId), eq(userGitIdentities.email, email)));
      await tx
        .insert(knownOtherIdentities)
        .values({ userId, email, name: identity.name })
        .onConflictDoUpdate({
          target: [knownOtherIdentities.userId, knownOtherIdentities.email],
          set: { name: identity.name },
        });
    }
  });
}
