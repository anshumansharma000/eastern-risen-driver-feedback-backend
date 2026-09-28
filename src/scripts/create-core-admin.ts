import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { loadConfig } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { auditEvents, authAccounts } from '../database/schema/index.js';
import { passwordHasher } from '../modules/auth/password.js';

const username = process.env.CORE_ADMIN_USERNAME?.trim().toLowerCase();
if (!username || !/^[a-z0-9_.-]{3,64}$/.test(username))
  throw new Error(
    'CORE_ADMIN_USERNAME must contain 3–64 letters, digits, dots, underscores or hyphens',
  );
const email = process.env.CORE_ADMIN_EMAIL?.trim().toLowerCase();
const displayName = process.env.CORE_ADMIN_DISPLAY_NAME?.trim();
const password = process.env.CORE_ADMIN_PASSWORD;

if (!email || !displayName || !password) {
  throw new Error(
    'CORE_ADMIN_EMAIL, CORE_ADMIN_DISPLAY_NAME, and CORE_ADMIN_PASSWORD are required',
  );
}
if (password.length < 12 || password.length > 128) {
  throw new Error('CORE_ADMIN_PASSWORD must contain between 12 and 128 characters');
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
      .values({ username, role: 'CORE_ADMIN', displayName, email, passwordHash })
      .returning({ id: authAccounts.id, email: authAccounts.email });
    await tx.insert(auditEvents).values({
      action: 'CORE_ADMIN_PROVISIONED',
      entityType: 'AUTH_ACCOUNT',
      entityId: created!.id,
      metadata: { role: 'CORE_ADMIN' },
    });
    return created!;
  });

  process.stdout.write(`Created administrator ${account.email} (${account.id})\n`);
} finally {
  await database.close();
}
