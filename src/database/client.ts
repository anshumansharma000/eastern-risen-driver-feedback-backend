import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { AppConfig } from '../config/env.js';
import * as schema from './schema/index.js';

export type AppDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  readonly db: AppDatabase;
  readonly pool: Pool;
  checkHealth(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabaseClient(config: AppConfig): DatabaseClient {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl,
    max: config.databaseMaxConnections,
    application_name: 'driver-feedback-api',
  });
  const db = drizzle({ client: pool, schema });

  return {
    db,
    pool,
    async checkHealth(): Promise<void> {
      await pool.query('select 1');
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
