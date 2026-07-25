import { and, eq, isNull, ne } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  auditEvents,
  authAccounts,
  authSessions,
  drivers,
  vendors,
} from '../../database/schema/index.js';
import { isPostgresError } from '../../shared/database/postgres-error.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { PasswordHasher } from '../auth/password.js';

export interface UpdateProfileInput {
  readonly displayName?: string;
  readonly email?: string;
  readonly phone?: string | null;
}

const adminProfileSelection = {
  accountId: authAccounts.id,
  role: authAccounts.role,
  displayName: authAccounts.displayName,
  email: authAccounts.email,
  status: authAccounts.status,
  passwordChangedAt: authAccounts.passwordChangedAt,
  lastLoginAt: authAccounts.lastLoginAt,
  createdAt: authAccounts.createdAt,
  updatedAt: authAccounts.updatedAt,
};

const driverProfileSelection = {
  ...adminProfileSelection,
  driverId: drivers.id,
  driverCode: drivers.driverCode,
  phone: drivers.phone,
  sourceType: drivers.sourceType,
  vendorId: drivers.vendorId,
  vendorName: vendors.name,
  assignmentEnabled: drivers.assignmentEnabled,
  shiftStartTime: drivers.shiftStartTime,
  shiftEndTime: drivers.shiftEndTime,
  timeZone: drivers.timeZone,
  maxDailyDutyMinutes: drivers.maxDailyDutyMinutes,
};

export class ProfileService {
  constructor(
    private readonly db: AppDatabase,
    private readonly passwords: PasswordHasher,
  ) {}

  async getAdmin(accountId: string) {
    const [profile] = await this.db
      .select(adminProfileSelection)
      .from(authAccounts)
      .where(and(eq(authAccounts.id, accountId), eq(authAccounts.role, 'ADMIN')))
      .limit(1);
    if (!profile) this.notFound();
    return { ...profile, role: 'ADMIN' as const };
  }

  async getDriver(accountId: string) {
    const [profile] = await this.db
      .select(driverProfileSelection)
      .from(authAccounts)
      .innerJoin(drivers, eq(drivers.accountId, authAccounts.id))
      .leftJoin(vendors, eq(vendors.id, drivers.vendorId))
      .where(and(eq(authAccounts.id, accountId), eq(authAccounts.role, 'DRIVER')))
      .limit(1);
    if (!profile) this.notFound();
    return { ...profile, role: 'DRIVER' as const };
  }

  async updateAdmin(accountId: string, input: UpdateProfileInput) {
    await this.updateAccount(accountId, input, 'ADMIN_PROFILE_UPDATED');
    return this.getAdmin(accountId);
  }

  async updateDriver(accountId: string, input: UpdateProfileInput) {
    try {
      await this.db.transaction(async (tx) => {
        const now = new Date();
        const [account] = await tx
          .update(authAccounts)
          .set({
            ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
            ...(input.email !== undefined ? { email: input.email.trim().toLowerCase() } : {}),
            updatedAt: now,
          })
          .where(and(eq(authAccounts.id, accountId), eq(authAccounts.role, 'DRIVER')))
          .returning({ id: authAccounts.id });
        if (!account) this.notFound();

        if (input.phone !== undefined) {
          await tx
            .update(drivers)
            .set({ phone: input.phone?.trim() || null, updatedAt: now })
            .where(eq(drivers.accountId, accountId));
        }
        await tx.insert(auditEvents).values({
          actorAccountId: accountId,
          action: 'DRIVER_PROFILE_UPDATED',
          entityType: 'AUTH_ACCOUNT',
          entityId: accountId,
          metadata: { changedFields: Object.keys(input).sort().join(',') },
        });
      });
      return this.getDriver(accountId);
    } catch (error) {
      this.throwAccountConflict(error);
    }
  }

  async changePassword(accountId: string, currentPassword: string, newPassword: string) {
    const [account] = await this.db
      .select({
        passwordHash: authAccounts.passwordHash,
        role: authAccounts.role,
      })
      .from(authAccounts)
      .where(and(eq(authAccounts.id, accountId), ne(authAccounts.status, 'ARCHIVED')))
      .limit(1);
    if (!account) this.notFound();

    const currentIsValid = await this.passwords.verify(account.passwordHash, currentPassword);
    if (!currentIsValid) {
      throw new AppError({
        code: 'CURRENT_PASSWORD_INVALID',
        message: 'The current password is incorrect',
        statusCode: 400,
      });
    }
    if (await this.passwords.verify(account.passwordHash, newPassword)) {
      throw new AppError({
        code: 'PASSWORD_REUSE_NOT_ALLOWED',
        message: 'The new password must differ from the current password',
        statusCode: 400,
      });
    }
    const passwordHash = await this.passwords.hash(newPassword);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(authAccounts)
        .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
        .where(eq(authAccounts.id, accountId));
      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(and(eq(authSessions.accountId, accountId), isNull(authSessions.revokedAt)));
      await tx.insert(auditEvents).values({
        actorAccountId: accountId,
        action: 'ACCOUNT_PASSWORD_CHANGED',
        entityType: 'AUTH_ACCOUNT',
        entityId: accountId,
        metadata: { role: account.role },
      });
    });
  }

  private async updateAccount(accountId: string, input: UpdateProfileInput, action: string) {
    try {
      await this.db.transaction(async (tx) => {
        const [account] = await tx
          .update(authAccounts)
          .set({
            ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
            ...(input.email !== undefined ? { email: input.email.trim().toLowerCase() } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(authAccounts.id, accountId), eq(authAccounts.role, 'ADMIN')))
          .returning({ id: authAccounts.id });
        if (!account) this.notFound();
        await tx.insert(auditEvents).values({
          actorAccountId: accountId,
          action,
          entityType: 'AUTH_ACCOUNT',
          entityId: accountId,
          metadata: { changedFields: Object.keys(input).sort().join(',') },
        });
      });
    } catch (error) {
      this.throwAccountConflict(error);
    }
  }

  private throwAccountConflict(error: unknown): never {
    if (isPostgresError(error, '23505')) {
      throw new AppError({
        code: 'ACCOUNT_EMAIL_ALREADY_EXISTS',
        message: 'This email address is already in use',
        statusCode: 409,
      });
    }
    throw error;
  }

  private notFound(): never {
    throw new AppError({
      code: 'PROFILE_NOT_FOUND',
      message: 'The account profile was not found',
      statusCode: 404,
    });
  }
}
