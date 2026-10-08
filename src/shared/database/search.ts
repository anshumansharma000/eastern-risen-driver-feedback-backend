import { sql, ilike, or, type SQL, type Column } from 'drizzle-orm';

/** Blank search is absent; %, _ and backslashes are literal user text. */
export function textSearch(q: string | undefined, columns: (Column | SQL)[]): SQL | undefined {
  const value = q?.trim();
  if (!value) return undefined;
  const pattern = `%${value.replace(/[\\%_]/g, '\\$&')}%`;
  return or(...columns.map((column) => ilike(sql`${column}::text`, pattern)));
}
