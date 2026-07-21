import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseConnection } from './src/config/database-connection.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run database commands');
}
const databaseConnection = resolveDatabaseConnection(process.env.DATABASE_URL);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: databaseConnection.url,
    ssl: databaseConnection.ssl,
  },
  strict: true,
  verbose: true,
});
