import { and, asc, count, eq, isNull, ne } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  auditEvents,
  authAccounts,
  authSessions,
  driverLeavePeriods,
  drivers,
  vendors,
} from '../../database/schema/index.js';
import { isPostgresError } from '../../shared/database/postgres-error.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { AccountStatus } from '../auth/auth.types.js';
import type { PasswordHasher } from '../auth/password.js';

export interface CreateDriverInput {
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  readonly driverCode: string;
  readonly phone?: string;
  readonly sourceType: 'AGENCY' | 'OUTSOURCED';
  readonly vendorId?: string | null;
  readonly assignmentEnabled?: boolean;
  readonly shiftStartTime?: string | null;
  readonly shiftEndTime?: string | null;
  readonly timeZone?: string;
  readonly maxDailyDutyMinutes?: number;
}

export interface ListDriversInput {
  readonly status?: AccountStatus;
  readonly page: number;
  readonly pageSize: number;
}

export interface UpdateDriverInput {
  readonly displayName?: string;
  readonly email?: string;
  readonly driverCode?: string;
  readonly phone?: string | null;
  readonly sourceType?: 'AGENCY' | 'OUTSOURCED';
  readonly vendorId?: string | null;
  readonly assignmentEnabled?: boolean;
  readonly shiftStartTime?: string | null;
  readonly shiftEndTime?: string | null;
  readonly timeZone?: string;
  readonly maxDailyDutyMinutes?: number;
}

export interface CreateDriverLeaveInput {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reason?: string;
}

export interface ListDriverLeavesInput {
  readonly page: number;
  readonly pageSize: number;
}

const driverSelection = {
  id: drivers.id,
  accountId: authAccounts.id,
  displayName: authAccounts.displayName,
  email: authAccounts.email,
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
  status: authAccounts.status,
  createdAt: drivers.createdAt,
  updatedAt: drivers.updatedAt,
  archivedAt: authAccounts.archivedAt,
};

export class DriverService {
  constructor(
    private readonly db: AppDatabase,
    private readonly passwords: PasswordHasher,
  ) {}

  async create(input: CreateDriverInput, actorAccountId: string) {
    const vendorName = await this.resolveVendorName(input.sourceType, input.vendorId);
    validateScheduleSettings(input.shiftStartTime, input.shiftEndTime, input.timeZone);

    const passwordHash = await this.passwords.hash(input.password);

    try {
      return await this.db.transaction(async (tx) => {
        const [account] = await tx
          .insert(authAccounts)
          .values({
            role: 'DRIVER',
            displayName: input.displayName.trim(),
            email: input.email.trim().toLowerCase(),
            passwordHash,
          })
          .returning({ id: authAccounts.id });

        const [driver] = await tx
          .insert(drivers)
          .values({
            accountId: account!.id,
            driverCode: input.driverCode.trim(),
            phone: input.phone?.trim() || null,
            sourceType: input.sourceType,
            vendorId: input.sourceType === 'OUTSOURCED' ? input.vendorId : null,
            assignmentEnabled: input.assignmentEnabled ?? true,
            shiftStartTime: input.shiftStartTime ?? null,
            shiftEndTime: input.shiftEndTime ?? null,
            timeZone: input.timeZone ?? 'Asia/Kolkata',
            maxDailyDutyMinutes: input.maxDailyDutyMinutes ?? 720,
          })
          .returning();

        await tx.insert(auditEvents).values({
          actorAccountId,
          action: 'DRIVER_CREATED',
          entityType: 'DRIVER',
          entityId: driver!.id,
          metadata: {
            driverCode: driver!.driverCode,
            sourceType: driver!.sourceType,
          },
        });

        return {
          ...driver!,
          displayName: input.displayName.trim(),
          email: input.email.trim().toLowerCase(),
          vendorName,
          status: 'ACTIVE' as const,
          archivedAt: null,
        };
      });
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        const driverCodeConflict = error.constraint === 'drivers_code_unique';
        throw new AppError({
          code: driverCodeConflict ? 'DRIVER_CODE_ALREADY_EXISTS' : 'ACCOUNT_EMAIL_ALREADY_EXISTS',
          message: driverCodeConflict
            ? 'This driver ID is already in use'
            : 'This email address is already in use',
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateDriverInput, actorAccountId: string) {
    const [current] = await this.db
      .select({
        accountId: authAccounts.id,
        sourceType: drivers.sourceType,
        vendorId: drivers.vendorId,
        shiftStartTime: drivers.shiftStartTime,
        shiftEndTime: drivers.shiftEndTime,
        timeZone: drivers.timeZone,
      })
      .from(drivers)
      .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
      .where(eq(drivers.id, id))
      .limit(1);
    if (!current) {
      throw new AppError({
        code: 'DRIVER_NOT_FOUND',
        message: 'Driver was not found',
        statusCode: 404,
      });
    }

    const sourceType = input.sourceType ?? current.sourceType;
    const vendorId = input.vendorId !== undefined ? input.vendorId : current.vendorId;
    await this.resolveVendorName(sourceType, vendorId);
    validateScheduleSettings(
      input.shiftStartTime !== undefined ? input.shiftStartTime : current.shiftStartTime,
      input.shiftEndTime !== undefined ? input.shiftEndTime : current.shiftEndTime,
      input.timeZone ?? current.timeZone,
    );

    try {
      return await this.db.transaction(async (tx) => {
        if (input.displayName !== undefined || input.email !== undefined) {
          await tx
            .update(authAccounts)
            .set({
              ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
              ...(input.email !== undefined ? { email: input.email.trim().toLowerCase() } : {}),
              updatedAt: new Date(),
            })
            .where(eq(authAccounts.id, current.accountId));
        }
        await tx
          .update(drivers)
          .set({
            ...(input.driverCode !== undefined ? { driverCode: input.driverCode.trim() } : {}),
            ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
            sourceType,
            vendorId: sourceType === 'OUTSOURCED' ? vendorId : null,
            ...(input.assignmentEnabled !== undefined
              ? { assignmentEnabled: input.assignmentEnabled }
              : {}),
            ...(input.shiftStartTime !== undefined ? { shiftStartTime: input.shiftStartTime } : {}),
            ...(input.shiftEndTime !== undefined ? { shiftEndTime: input.shiftEndTime } : {}),
            ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
            ...(input.maxDailyDutyMinutes !== undefined
              ? { maxDailyDutyMinutes: input.maxDailyDutyMinutes }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(drivers.id, id));

        await tx.insert(auditEvents).values({
          actorAccountId,
          action: 'DRIVER_UPDATED',
          entityType: 'DRIVER',
          entityId: id,
          metadata: { changedFields: Object.keys(input).sort().join(',') },
        });

        const [driver] = await tx
          .select(driverSelection)
          .from(drivers)
          .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
          .leftJoin(vendors, eq(vendors.id, drivers.vendorId))
          .where(eq(drivers.id, id))
          .limit(1);
        return driver!;
      });
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        const driverCodeConflict = error.constraint === 'drivers_code_unique';
        throw new AppError({
          code: driverCodeConflict ? 'DRIVER_CODE_ALREADY_EXISTS' : 'ACCOUNT_EMAIL_ALREADY_EXISTS',
          message: driverCodeConflict
            ? 'This driver ID is already in use'
            : 'This email address is already in use',
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  async get(id: string) {
    const [driver] = await this.db
      .select(driverSelection)
      .from(drivers)
      .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
      .leftJoin(vendors, eq(vendors.id, drivers.vendorId))
      .where(eq(drivers.id, id))
      .limit(1);
    if (!driver) {
      throw new AppError({
        code: 'DRIVER_NOT_FOUND',
        message: 'Driver was not found',
        statusCode: 404,
      });
    }
    return driver;
  }

  async list(input: ListDriversInput) {
    const filter = input.status
      ? eq(authAccounts.status, input.status)
      : ne(authAccounts.status, 'ARCHIVED');
    const offset = (input.page - 1) * input.pageSize;
    const baseJoin = this.db
      .select(driverSelection)
      .from(drivers)
      .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
      .leftJoin(vendors, eq(vendors.id, drivers.vendorId));

    const [items, [total]] = await Promise.all([
      baseJoin
        .where(filter)
        .orderBy(asc(authAccounts.displayName), asc(drivers.id))
        .limit(input.pageSize)
        .offset(offset),
      this.db
        .select({ value: count() })
        .from(drivers)
        .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
        .where(filter),
    ]);
    return { items, total: total?.value ?? 0 };
  }

  async resetPassword(id: string, newPassword: string, actorAccountId: string) {
    const [driver] = await this.db
      .select({
        accountId: authAccounts.id,
        status: authAccounts.status,
      })
      .from(drivers)
      .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
      .where(eq(drivers.id, id))
      .limit(1);
    if (!driver || driver.status === 'ARCHIVED') {
      throw new AppError({
        code: 'DRIVER_NOT_FOUND',
        message: 'Driver was not found',
        statusCode: 404,
      });
    }

    const passwordHash = await this.passwords.hash(newPassword);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const [updatedAccount] = await tx
        .update(authAccounts)
        .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
        .where(and(eq(authAccounts.id, driver.accountId), ne(authAccounts.status, 'ARCHIVED')))
        .returning({ id: authAccounts.id });
      if (!updatedAccount) {
        throw new AppError({
          code: 'DRIVER_NOT_FOUND',
          message: 'Driver was not found',
          statusCode: 404,
        });
      }
      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(and(eq(authSessions.accountId, driver.accountId), isNull(authSessions.revokedAt)));
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'DRIVER_PASSWORD_RESET',
        entityType: 'DRIVER',
        entityId: id,
        metadata: { sessionsRevoked: true },
      });
    });
  }

  async changeStatus(id: string, status: AccountStatus, actorAccountId: string) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [result] = await tx
        .update(authAccounts)
        .set({
          status,
          archivedAt: status === 'ARCHIVED' ? now : null,
          updatedAt: now,
        })
        .from(drivers)
        .where(and(eq(drivers.id, id), eq(authAccounts.id, drivers.accountId)))
        .returning({ accountId: authAccounts.id });

      if (!result) {
        throw new AppError({
          code: 'DRIVER_NOT_FOUND',
          message: 'Driver was not found',
          statusCode: 404,
        });
      }
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'DRIVER_STATUS_CHANGED',
        entityType: 'DRIVER',
        entityId: id,
        metadata: { status },
      });

      const [driver] = await tx
        .select(driverSelection)
        .from(drivers)
        .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
        .leftJoin(vendors, eq(vendors.id, drivers.vendorId))
        .where(eq(drivers.id, id))
        .limit(1);
      return driver!;
    });
  }

  async createLeave(id: string, input: CreateDriverLeaveInput, actorAccountId: string) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (endsAt <= startsAt) {
      throw new AppError({
        code: 'INVALID_DRIVER_LEAVE_PERIOD',
        message: 'Driver leave must end after it starts',
        statusCode: 400,
      });
    }
    return this.db.transaction(async (tx) => {
      const [driver] = await tx.select({ id: drivers.id }).from(drivers).where(eq(drivers.id, id));
      if (!driver) {
        throw new AppError({
          code: 'DRIVER_NOT_FOUND',
          message: 'Driver was not found',
          statusCode: 404,
        });
      }
      const [leave] = await tx
        .insert(driverLeavePeriods)
        .values({
          driverId: id,
          startsAt,
          endsAt,
          reason: input.reason?.trim() || null,
        })
        .returning();
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'DRIVER_LEAVE_CREATED',
        entityType: 'DRIVER',
        entityId: id,
        metadata: { leaveId: leave!.id },
      });
      return leave!;
    });
  }

  async listLeaves(id: string, input: ListDriverLeavesInput) {
    const [driver] = await this.db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.id, id));
    if (!driver) {
      throw new AppError({
        code: 'DRIVER_NOT_FOUND',
        message: 'Driver was not found',
        statusCode: 404,
      });
    }
    const filter = eq(driverLeavePeriods.driverId, id);
    const offset = (input.page - 1) * input.pageSize;
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(driverLeavePeriods)
        .where(filter)
        .orderBy(asc(driverLeavePeriods.startsAt), asc(driverLeavePeriods.id))
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(driverLeavePeriods).where(filter),
    ]);
    return { items, total: total?.value ?? 0 };
  }

  async deleteLeave(id: string, leaveId: string, actorAccountId: string) {
    return this.db.transaction(async (tx) => {
      const [leave] = await tx
        .delete(driverLeavePeriods)
        .where(and(eq(driverLeavePeriods.id, leaveId), eq(driverLeavePeriods.driverId, id)))
        .returning({ id: driverLeavePeriods.id });
      if (!leave) {
        throw new AppError({
          code: 'DRIVER_LEAVE_NOT_FOUND',
          message: 'Driver leave was not found',
          statusCode: 404,
        });
      }
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'DRIVER_LEAVE_DELETED',
        entityType: 'DRIVER',
        entityId: id,
        metadata: { leaveId },
      });
    });
  }

  private async resolveVendorName(
    sourceType: 'AGENCY' | 'OUTSOURCED',
    vendorId: string | null | undefined,
  ): Promise<string | null> {
    if (sourceType === 'AGENCY') return null;
    if (!vendorId) {
      throw new AppError({
        code: 'VENDOR_REQUIRED_FOR_OUTSOURCED_DRIVER',
        message: 'An active vendor is required for an outsourced driver',
        statusCode: 400,
      });
    }
    const [vendor] = await this.db
      .select({ name: vendors.name })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.status, 'ACTIVE')))
      .limit(1);
    if (!vendor) {
      throw new AppError({
        code: 'ACTIVE_VENDOR_NOT_FOUND',
        message: 'The selected vendor is unavailable',
        statusCode: 400,
      });
    }
    return vendor.name;
  }
}

function validateScheduleSettings(
  shiftStartTime: string | null | undefined,
  shiftEndTime: string | null | undefined,
  timeZone: string | undefined,
) {
  if ((shiftStartTime == null) !== (shiftEndTime == null)) {
    throw new AppError({
      code: 'INVALID_DRIVER_SHIFT',
      message: 'Shift start and end times must either both be set or both be empty',
      statusCode: 400,
    });
  }
  if (shiftStartTime != null && shiftStartTime === shiftEndTime) {
    throw new AppError({
      code: 'INVALID_DRIVER_SHIFT',
      message: 'Shift start and end times must differ',
      statusCode: 400,
    });
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
  } catch {
    throw new AppError({
      code: 'INVALID_TIME_ZONE',
      message: 'The selected time zone is invalid',
      statusCode: 400,
    });
  }
}
