import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
// Schema-independent query surface. Core cannot use the shared relational query API.
export type CoreTransaction = Pick<
  NodePgDatabase,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;
export type CoreDatabase = CoreTransaction & {
  transaction<T>(work: (tx: CoreTransaction) => Promise<T>): Promise<T>;
};
