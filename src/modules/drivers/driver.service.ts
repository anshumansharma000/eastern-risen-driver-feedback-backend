import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { auditEvents, authAccounts, drivers, vendors } from '../../database/schema/index.js';
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
      })
      .from(drivers)
      .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
      .where(eq(drivers.id, id))
      .limit(1);
    if (!current) {
      throw new AppError({ code: 'DRIVER_NOT_FOUND', message: 'Driver was not found', statusCode: 404 });
    }

    const sourceType = input.sourceType ?? current.sourceType;
    const vendorId = input.vendorId !== undefined ? input.vendorId : current.vendorId;
    await this.resolveVendorName(sourceType, vendorId);

    try {
      return await this.db.transaction(async (tx) => {
        if (input.displayName !== undefined || input.email !== undefined) {
          await tx
            .update(authAccounts)
            .set({
              ...(input.displayName !== undefined
                ? { displayName: input.displayName.trim() }
                : {}),
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
      baseJoin.where(filter).orderBy(asc(authAccounts.displayName)).limit(input.pageSize).offset(offset),
      this.db
        .select({ value: count() })
        .from(drivers)
        .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
        .where(filter),
    ]);
    return { items, total: total?.value ?? 0 };
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
