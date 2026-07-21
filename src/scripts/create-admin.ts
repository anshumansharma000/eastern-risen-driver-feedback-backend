import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { loadConfig } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { auditEvents, authAccounts } from '../database/schema/index.js';
import { passwordHasher } from '../modules/auth/password.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const displayName = process.env.ADMIN_DISPLAY_NAME?.trim();
const password = process.env.ADMIN_PASSWORD;

if (!email || !displayName || !password) {
  throw new Error('ADMIN_EMAIL, ADMIN_DISPLAY_NAME, and ADMIN_PASSWORD are required');
}
if (password.length < 12 || password.length > 128) {
  throw new Error('ADMIN_PASSWORD must contain between 12 and 128 characters');
}

const database = createDatabaseClient(loadConfig());

try {
  const [existing] = await database.db
    .select({ id: authAccounts.id })
    .from(authAccounts)
    .where(eq(sql`lower(${authAccounts.email})`, email))
    .limit(1);

  if (existing) throw new Error('An account with this email address already exists');

  const passwordHash = await passwordHasher.hash(password);
  const account = await database.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(authAccounts)
      .values({ role: 'ADMIN', displayName, email, passwordHash })
      .returning({ id: authAccounts.id, email: authAccounts.email });
    await tx.insert(auditEvents).values({
      action: 'ADMIN_PROVISIONED',
      entityType: 'AUTH_ACCOUNT',
      entityId: created!.id,
      metadata: { role: 'ADMIN' },
    });
    return created!;
  });

  process.stdout.write(`Created administrator ${account.email} (${account.id})\n`);
} finally {
  await database.close();
}
