import 'dotenv/config';
import { and, isNotNull, lt, or } from 'drizzle-orm';
import { loadConfig } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { authSessions } from '../database/schema/index.js';

const database = createDatabaseClient(loadConfig());

try {
  const now = new Date();
  const revokedRetentionCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const deleted = await database.db
    .delete(authSessions)
    .where(
      or(
        lt(authSessions.expiresAt, now),
        and(isNotNull(authSessions.revokedAt), lt(authSessions.revokedAt, revokedRetentionCutoff)),
      ),
    )
    .returning({ id: authSessions.id });
  process.stdout.write(`Deleted ${deleted.length} expired or old revoked sessions\n`);
} finally {
  await database.close();
}
