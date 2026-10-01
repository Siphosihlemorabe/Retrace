/**
 * Database types for code that receives a connection rather than importing
 * one. `client.ts` connects on import and throws without DATABASE_URL, so
 * `core/` takes an `Executor` argument instead — which is also what lets tests
 * hand it the test database, and lets a caller pass a transaction.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything a query can run on: the pool-backed db, or an open transaction. */
export type Executor = Db | Tx;
