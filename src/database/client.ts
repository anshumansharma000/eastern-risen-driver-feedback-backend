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

export type DatabasePoolErrorHandler = (error: Error) => void;

function reportUnexpectedPoolError(error: Error): void {
  console.error('Unexpected error on idle PostgreSQL connection', error);
}

export function createDatabaseClient(
  config: AppConfig,
  onPoolError: DatabasePoolErrorHandler = reportUnexpectedPoolError,
): DatabaseClient {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl,
    max: config.databaseMaxConnections,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    idleTimeoutMillis: config.databaseIdleTimeoutMs,
    statement_timeout: config.databaseStatementTimeoutMs,
    application_name: 'driver-feedback-api',
  });
  // Idle clients can still fail during a database restart, failover, or network
  // interruption. pg removes the failed client, but an unhandled pool "error"
  // event would otherwise terminate the Node.js process.
  pool.on('error', onPoolError);
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
