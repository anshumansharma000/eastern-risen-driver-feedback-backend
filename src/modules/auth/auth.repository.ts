import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { authAccounts, authSessions, drivers } from '../../database/schema/index.js';
import type { AuthAccount, AuthPrincipal } from './auth.types.js';

export interface AuthRepository {
  findAdminByEmail(email: string): Promise<AuthAccount | null>;
  findDriverByCode(driverCode: string): Promise<AuthAccount | null>;
  createSession(accountId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findPrincipalBySessionHash(tokenHash: string, now: Date): Promise<AuthPrincipal | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  recordSuccessfulLogin(accountId: string, now: Date): Promise<void>;
}

const accountSelection = {
  accountId: authAccounts.id,
  role: authAccounts.role,
  status: authAccounts.status,
  displayName: authAccounts.displayName,
  passwordHash: authAccounts.passwordHash,
  passwordChangedAt: authAccounts.passwordChangedAt,
  driverId: drivers.id,
};

export class DrizzleAuthRepository implements AuthRepository {
  constructor(private readonly db: AppDatabase) {}

  async findAdminByEmail(email: string): Promise<AuthAccount | null> {
    const [account] = await this.db
      .select(accountSelection)
      .from(authAccounts)
      .leftJoin(drivers, eq(drivers.accountId, authAccounts.id))
      .where(
        and(
          eq(authAccounts.role, 'ADMIN'),
          eq(sql`lower(${authAccounts.email})`, email.toLowerCase()),
        ),
      )
      .limit(1);

    return account ?? null;
  }

  async findDriverByCode(driverCode: string): Promise<AuthAccount | null> {
    const [account] = await this.db
      .select(accountSelection)
      .from(authAccounts)
      .innerJoin(drivers, eq(drivers.accountId, authAccounts.id))
      .where(eq(sql`lower(${drivers.driverCode})`, driverCode.toLowerCase()))
      .limit(1);

    return account ?? null;
  }

  async createSession(accountId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.insert(authSessions).values({ accountId, tokenHash, expiresAt });
  }

  async findPrincipalBySessionHash(tokenHash: string, now: Date): Promise<AuthPrincipal | null> {
    const [session] = await this.db
      .select({
        accountId: authAccounts.id,
        role: authAccounts.role,
        displayName: authAccounts.displayName,
        driverId: drivers.id,
      })
      .from(authSessions)
      .innerJoin(authAccounts, eq(authAccounts.id, authSessions.accountId))
      .leftJoin(drivers, eq(drivers.accountId, authAccounts.id))
      .where(
        and(
          eq(authSessions.tokenHash, tokenHash),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
          eq(authAccounts.status, 'ACTIVE'),
          lte(authAccounts.passwordChangedAt, authSessions.createdAt),
        ),
      )
      .limit(1);

    if (!session) return null;

    await this.db
      .update(authSessions)
      .set({ lastSeenAt: now })
      .where(eq(authSessions.tokenHash, tokenHash));

    return session;
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)));
  }

  async recordSuccessfulLogin(accountId: string, now: Date): Promise<void> {
    await this.db
      .update(authAccounts)
      .set({ lastLoginAt: now })
      .where(eq(authAccounts.id, accountId));
  }
}
