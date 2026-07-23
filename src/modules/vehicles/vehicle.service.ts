import { asc, count, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { auditEvents, vehicles } from '../../database/schema/index.js';
import { isPostgresError } from '../../shared/database/postgres-error.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { AccountStatus } from '../auth/auth.types.js';

export interface CreateVehicleInput {
  readonly registrationNumber: string;
  readonly displayName: string;
}

export interface UpdateVehicleInput {
  readonly registrationNumber?: string;
  readonly displayName?: string;
}

export interface ListVehiclesInput {
  readonly status?: AccountStatus;
  readonly page: number;
  readonly pageSize: number;
}

export class VehicleService {
  constructor(private readonly db: AppDatabase) {}

  async create(input: CreateVehicleInput, actorAccountId: string) {
    try {
      return await this.db.transaction(async (tx) => {
        const [vehicle] = await tx
          .insert(vehicles)
          .values({
            registrationNumber: normalizeRegistration(input.registrationNumber),
            displayName: input.displayName.trim(),
          })
          .returning();
        if (!vehicle) throw new Error('Vehicle insert did not return a row');
        await tx.insert(auditEvents).values({
          actorAccountId,
          action: 'VEHICLE_CREATED',
          entityType: 'VEHICLE',
          entityId: vehicle.id,
          metadata: { registrationNumber: vehicle.registrationNumber },
        });
        return vehicle;
      });
    } catch (error) {
      this.throwConflict(error);
    }
  }

  async update(id: string, input: UpdateVehicleInput, actorAccountId: string) {
    try {
      return await this.db.transaction(async (tx) => {
        const [vehicle] = await tx
          .update(vehicles)
          .set({
            ...(input.registrationNumber !== undefined
              ? { registrationNumber: normalizeRegistration(input.registrationNumber) }
              : {}),
            ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
            updatedAt: new Date(),
          })
          .where(eq(vehicles.id, id))
          .returning();
        if (!vehicle) this.notFound();
        await tx.insert(auditEvents).values({
          actorAccountId,
          action: 'VEHICLE_UPDATED',
          entityType: 'VEHICLE',
          entityId: vehicle.id,
          metadata: { changedFields: Object.keys(input).sort().join(',') },
        });
        return vehicle;
      });
    } catch (error) {
      this.throwConflict(error);
    }
  }

  async get(id: string) {
    const [vehicle] = await this.db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
    if (!vehicle) this.notFound();
    return vehicle;
  }

  async list(input: ListVehiclesInput) {
    const filter = input.status
      ? eq(vehicles.status, input.status)
      : ne(vehicles.status, 'ARCHIVED');
    const offset = (input.page - 1) * input.pageSize;
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(vehicles)
        .where(filter)
        .orderBy(asc(vehicles.registrationNumber))
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(vehicles).where(filter),
    ]);
    return { items, total: total?.value ?? 0 };
  }

  async changeStatus(id: string, status: AccountStatus, actorAccountId: string) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [vehicle] = await tx
        .update(vehicles)
        .set({
          status,
          archivedAt: status === 'ARCHIVED' ? now : null,
          updatedAt: now,
        })
        .where(eq(vehicles.id, id))
        .returning();
      if (!vehicle) this.notFound();
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'VEHICLE_STATUS_CHANGED',
        entityType: 'VEHICLE',
        entityId: vehicle.id,
        metadata: { status },
      });
      return vehicle;
    });
  }

  private throwConflict(error: unknown): never {
    if (isPostgresError(error, '23505')) {
      throw new AppError({
        code: 'VEHICLE_REGISTRATION_ALREADY_EXISTS',
        message: 'This vehicle registration number is already in use',
        statusCode: 409,
      });
    }
    throw error;
  }

  private notFound(): never {
    throw new AppError({
      code: 'VEHICLE_NOT_FOUND',
      message: 'Vehicle was not found',
      statusCode: 404,
    });
  }
}

function normalizeRegistration(value: string): string {
  return value.trim().toUpperCase().replaceAll(/\s+/g, ' ');
}
