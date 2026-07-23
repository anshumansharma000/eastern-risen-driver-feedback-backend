import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseConnection } from './src/config/database-connection.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run database commands');
}
const databaseConnection = resolveDatabaseConnection(process.env.DATABASE_URL);
const databaseUrl = new URL(databaseConnection.url);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 5432),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: decodeURIComponent(databaseUrl.pathname.slice(1)),
    ssl: databaseConnection.ssl,
  },
  strict: true,
  verbose: true,
});
