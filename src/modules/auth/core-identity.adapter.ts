import { textSearch } from '../../shared/database/search.js';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { authAccounts, authSessions, auditEvents } from '../../database/schema/index.js';
import type { CoreIdentity, CoreRole, CoreUser, CoreUserInput } from '../core/application/ports.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { PasswordHasher } from './password.js';
const roles: CoreRole[] = ['CORE_ADMIN', 'CORE_REPORT_VIEWER', 'CORE_DATA_ENTRY'];
const selection = {
  id: authAccounts.id,
  username: authAccounts.username,
  email: authAccounts.email,
  displayName: authAccounts.displayName,
  role: authAccounts.role,
  status: authAccounts.status,
};
const notFound = () =>
  new AppError({
    code: 'CORE_USER_NOT_FOUND',
    message: 'Core user was not found',
    statusCode: 404,
  });
function user(
  record:
    | typeof authAccounts.$inferSelect
    | {
        id: string;
        username: string | null;
        email: string;
        displayName: string;
        role: string;
        status: CoreUser['status'];
      },
): CoreUser {
  if (!roles.includes(record.role as CoreRole)) throw notFound();
  return {
    id: record.id,
    username: record.username,
    email: record.email,
    displayName: record.displayName,
    role: record.role as CoreRole,
    status: record.status,
  };
}
/** Shared identity owns credentials and sessions; core only receives safe account projections. */
export class CoreIdentityAdapter implements CoreIdentity {
  constructor(
    private readonly db: AppDatabase,
    private readonly passwords: PasswordHasher,
  ) {}
  async createUser(input: CoreUserInput, actorId: string): Promise<CoreUser> {
    const passwordHash = await this.passwords.hash(input.password);
    return this.db.transaction(async (tx) => {
      const [account] = await tx
        .insert(authAccounts)
        .values({
          username: input.username.trim().toLowerCase(),
          email: input.email.trim().toLowerCase(),
          displayName: input.displayName.trim(),
          role: input.role,
          passwordHash,
        })
        .returning();
      await tx.insert(auditEvents).values({
        actorAccountId: actorId,
        action: 'CORE_USER_CREATED',
        entityType: 'AUTH_ACCOUNT',
        entityId: account!.id,
        metadata: { role: input.role },
      });
      return user(account!);
    });
  }
  async updateProfile(
    id: string,
    input: Pick<CoreUserInput, 'username' | 'email' | 'displayName'>,
    actorId: string,
  ): Promise<CoreUser> {
    return this.db.transaction(async (tx) => {
      const [account] = await tx
        .update(authAccounts)
        .set({
          username: input.username.trim().toLowerCase(),
          email: input.email.trim().toLowerCase(),
          displayName: input.displayName.trim(),
          updatedAt: new Date(),
        })
        .where(and(eq(authAccounts.id, id), inArray(authAccounts.role, roles)))
        .returning();
      if (!account) throw notFound();
      await tx.insert(auditEvents).values({
        actorAccountId: actorId,
        action: 'CORE_USER_PROFILE_UPDATED',
        entityType: 'AUTH_ACCOUNT',
        entityId: id,
      });
      return user(account);
    });
  }
  async listUsers(page: number, pageSize: number, q?: string, status?: CoreUser['status']) {
    const filter = and(
      inArray(authAccounts.role, roles),
      status ? eq(authAccounts.status, status) : undefined,
      textSearch(q, [authAccounts.displayName, authAccounts.username, authAccounts.email]),
    );
    const [items, [total]] = await Promise.all([
      this.db
        .select(selection)
        .from(authAccounts)
        .where(filter)
        .orderBy(asc(authAccounts.displayName), asc(authAccounts.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(authAccounts).where(filter),
    ]);
    return { items: items.map(user), total: total!.value };
  }
  async updateUser(
    id: string,
    input: { role: CoreRole; status: CoreUser['status'] },
    actorId: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(81002)`);
      const [account] = await tx
        .select()
        .from(authAccounts)
        .where(and(eq(authAccounts.id, id), inArray(authAccounts.role, roles)))
        .for('update');
      if (!account) throw notFound();
      if (
        account.role === 'CORE_ADMIN' &&
        account.status === 'ACTIVE' &&
        (input.role !== 'CORE_ADMIN' || input.status !== 'ACTIVE')
      ) {
        const [admins] = await tx
          .select({ value: count() })
          .from(authAccounts)
          .where(and(eq(authAccounts.role, 'CORE_ADMIN'), eq(authAccounts.status, 'ACTIVE')));
        if (admins!.value <= 1)
          throw new AppError({
            code: 'LAST_CORE_ADMIN',
            message: 'At least one active core administrator must remain',
            statusCode: 409,
          });
      }
      const [updated] = await tx
        .update(authAccounts)
        .set({
          ...input,
          archivedAt: input.status === 'ARCHIVED' ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(authAccounts.id, id))
        .returning();
      await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(eq(authSessions.accountId, id));
      await tx.insert(auditEvents).values({
        actorAccountId: actorId,
        action: 'CORE_USER_ACCESS_CHANGED',
        entityType: 'AUTH_ACCOUNT',
        entityId: id,
        metadata: { role: input.role, status: input.status },
      });
      return user(updated!);
    });
  }
  async resetPassword(id: string, password: string, actorId: string): Promise<void> {
    const passwordHash = await this.passwords.hash(password);
    await this.db.transaction(async (tx) => {
      const [account] = await tx
        .update(authAccounts)
        .set({ passwordHash, passwordChangedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(authAccounts.id, id), inArray(authAccounts.role, roles)))
        .returning({ id: authAccounts.id });
      if (!account) throw notFound();
      await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(eq(authSessions.accountId, id));
      await tx.insert(auditEvents).values({
        actorAccountId: actorId,
        action: 'CORE_USER_PASSWORD_RESET',
        entityType: 'AUTH_ACCOUNT',
        entityId: id,
      });
    });
  }
}
