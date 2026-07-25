import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { resolveDatabaseConnection } from '../config/database-connection.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run production migrations');
}

const databaseConnection = resolveDatabaseConnection(databaseUrl);
const pool = new Pool({
  connectionString: databaseConnection.url,
  ssl: databaseConnection.ssl,
  max: 1,
  connectionTimeoutMillis: 10_000,
  application_name: 'driver-feedback-migrator',
});

try {
  await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
} finally {
  await pool.end();
}
