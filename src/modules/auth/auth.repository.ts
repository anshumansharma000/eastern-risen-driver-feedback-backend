import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { authAccounts, authSessions, drivers } from '../../database/schema/index.js';
import type { AuthAccount, ResolvedAuthSession } from './auth.types.js';

export interface AuthRepository {
  findAdminByEmail(email: string): Promise<AuthAccount | null>;
  findDriverByCode(driverCode: string): Promise<AuthAccount | null>;
  createSession(
    accountId: string,
    tokenHash: string,
    expiresAt: Date,
    absoluteExpiresAt: Date,
  ): Promise<void>;
  findSessionByTokenHash(tokenHash: string, now: Date): Promise<ResolvedAuthSession | null>;
  rotateSession(
    sessionId: string,
    expectedTokenHash: string,
    newTokenHash: string,
    expiresAt: Date,
    previousTokenValidUntil: Date,
    now: Date,
  ): Promise<boolean>;
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

  async createSession(
    accountId: string,
    tokenHash: string,
    expiresAt: Date,
    absoluteExpiresAt: Date,
  ): Promise<void> {
    await this.db
      .insert(authSessions)
      .values({ accountId, tokenHash, expiresAt, absoluteExpiresAt });
  }

  async findSessionByTokenHash(tokenHash: string, now: Date): Promise<ResolvedAuthSession | null> {
    const [session] = await this.db
      .select({
        id: authSessions.id,
        accountId: authAccounts.id,
        role: authAccounts.role,
        displayName: authAccounts.displayName,
        driverId: drivers.id,
        tokenHash: authSessions.tokenHash,
        expiresAt: authSessions.expiresAt,
        absoluteExpiresAt: authSessions.absoluteExpiresAt,
        rotatedAt: authSessions.rotatedAt,
      })
      .from(authSessions)
      .innerJoin(authAccounts, eq(authAccounts.id, authSessions.accountId))
      .leftJoin(drivers, eq(drivers.accountId, authAccounts.id))
      .where(
        and(
          or(
            eq(authSessions.tokenHash, tokenHash),
            and(
              eq(authSessions.previousTokenHash, tokenHash),
              gt(authSessions.previousTokenValidUntil, now),
            ),
          ),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
          gt(authSessions.absoluteExpiresAt, now),
          eq(authAccounts.status, 'ACTIVE'),
          lte(authAccounts.passwordChangedAt, authSessions.createdAt),
        ),
      )
      .limit(1);

    if (!session) return null;

    await this.db
      .update(authSessions)
      .set({ lastSeenAt: now })
      .where(eq(authSessions.id, session.id));

    return {
      id: session.id,
      principal: {
        accountId: session.accountId,
        role: session.role,
        displayName: session.displayName,
        driverId: session.driverId,
      },
      tokenHash: session.tokenHash,
      matchedCurrentToken: session.tokenHash === tokenHash,
      expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      rotatedAt: session.rotatedAt,
    };
  }

  async rotateSession(
    sessionId: string,
    expectedTokenHash: string,
    newTokenHash: string,
    expiresAt: Date,
    previousTokenValidUntil: Date,
    now: Date,
  ): Promise<boolean> {
    const updated = await this.db
      .update(authSessions)
      .set({
        tokenHash: newTokenHash,
        previousTokenHash: expectedTokenHash,
        previousTokenValidUntil,
        expiresAt,
        lastSeenAt: now,
        rotatedAt: now,
      })
      .where(
        and(
          eq(authSessions.id, sessionId),
          eq(authSessions.tokenHash, expectedTokenHash),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
          gt(authSessions.absoluteExpiresAt, now),
        ),
      )
      .returning({ id: authSessions.id });

    return updated.length === 1;
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(
        and(
          or(
            eq(authSessions.tokenHash, tokenHash),
            and(
              eq(authSessions.previousTokenHash, tokenHash),
              gt(authSessions.previousTokenValidUntil, now),
            ),
          ),
          isNull(authSessions.revokedAt),
        ),
      );
  }

  async recordSuccessfulLogin(accountId: string, now: Date): Promise<void> {
    await this.db
      .update(authAccounts)
      .set({ lastLoginAt: now })
      .where(eq(authAccounts.id, accountId));
  }
}
