import { asc, count, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { auditEvents, vendors } from '../../database/schema/index.js';
import { AppError } from '../../shared/errors/app-error.js';
import { isPostgresError } from '../../shared/database/postgres-error.js';
import type { AccountStatus } from '../auth/auth.types.js';

export interface CreateVendorInput {
  readonly name: string;
  readonly contactName?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
}

export interface ListVendorsInput {
  readonly status?: AccountStatus;
  readonly page: number;
  readonly pageSize: number;
}

export interface UpdateVendorInput {
  readonly name?: string;
  readonly contactName?: string | null;
  readonly contactEmail?: string | null;
  readonly contactPhone?: string | null;
}

export class VendorService {
  constructor(private readonly db: AppDatabase) {}

  async create(input: CreateVendorInput, actorAccountId: string) {
    try {
      return await this.db.transaction(async (tx) => {
        const [vendor] = await tx
          .insert(vendors)
          .values({
            name: input.name.trim(),
            contactName: input.contactName?.trim() || null,
            contactEmail: input.contactEmail?.trim().toLowerCase() || null,
            contactPhone: input.contactPhone?.trim() || null,
          })
          .returning();
        await tx.insert(auditEvents).values({
          actorAccountId,
          action: 'VENDOR_CREATED',
          entityType: 'VENDOR',
          entityId: vendor!.id,
          metadata: { name: vendor!.name },
        });
        return vendor!;
      });
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        throw new AppError({
          code: 'VENDOR_NAME_ALREADY_EXISTS',
          message: 'An active vendor with this name already exists',
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateVendorInput, actorAccountId: string) {
    try {
      return await this.db.transaction(async (tx) => {
        const [vendor] = await tx
          .update(vendors)
          .set({
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.contactName !== undefined
              ? { contactName: input.contactName?.trim() || null }
              : {}),
            ...(input.contactEmail !== undefined
              ? { contactEmail: input.contactEmail?.trim().toLowerCase() || null }
              : {}),
            ...(input.contactPhone !== undefined
              ? { contactPhone: input.contactPhone?.trim() || null }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(vendors.id, id))
          .returning();
        if (!vendor) {
          throw new AppError({
            code: 'VENDOR_NOT_FOUND',
            message: 'Vendor was not found',
            statusCode: 404,
          });
        }
        await tx.insert(auditEvents).values({
          actorAccountId,
          action: 'VENDOR_UPDATED',
          entityType: 'VENDOR',
          entityId: vendor.id,
          metadata: { changedFields: Object.keys(input).sort().join(',') },
        });
        return vendor;
      });
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        throw new AppError({
          code: 'VENDOR_NAME_ALREADY_EXISTS',
          message: 'An active vendor with this name already exists',
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  async list(input: ListVendorsInput) {
    const filter = input.status ? eq(vendors.status, input.status) : ne(vendors.status, 'ARCHIVED');
    const offset = (input.page - 1) * input.pageSize;
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(vendors)
        .where(filter)
        .orderBy(asc(vendors.name))
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(vendors).where(filter),
    ]);

    return { items, total: total?.value ?? 0 };
  }

  async changeStatus(id: string, status: AccountStatus, actorAccountId: string) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [vendor] = await tx
        .update(vendors)
        .set({
          status,
          archivedAt: status === 'ARCHIVED' ? now : null,
          updatedAt: now,
        })
        .where(eq(vendors.id, id))
        .returning();

      if (!vendor) {
        throw new AppError({
          code: 'VENDOR_NOT_FOUND',
          message: 'Vendor was not found',
          statusCode: 404,
        });
      }
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'VENDOR_STATUS_CHANGED',
        entityType: 'VENDOR',
        entityId: vendor.id,
        metadata: { status },
      });
      return vendor;
    });
  }
}
