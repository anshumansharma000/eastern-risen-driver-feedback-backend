import { and, count, desc, eq, ne, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  auditEvents,
  authAccounts,
  drivers,
  trips,
  vehicles,
  vendors,
} from '../../database/schema/index.js';
import { AppError } from '../../shared/errors/app-error.js';

export type TripStatus = 'READY' | 'FEEDBACK_STARTED' | 'SUBMITTED' | 'ARCHIVED';
export type TripCreationSource = 'ADMIN_ASSIGNED' | 'DRIVER_ENTERED';

export interface CreateTripInput {
  readonly bookingReference: string;
  readonly passengerName: string;
  readonly pickupLocation: string;
  readonly destination: string;
  readonly scheduledAt: string;
  readonly vehicleId: string;
  readonly driverId: string;
}

export interface UpdateTripInput {
  readonly bookingReference?: string;
  readonly passengerName?: string;
  readonly pickupLocation?: string;
  readonly destination?: string;
  readonly scheduledAt?: string;
  readonly vehicleId?: string;
  readonly driverId?: string;
}

export interface ListTripsInput {
  readonly status?: TripStatus;
  readonly driverId?: string;
  readonly creationSource?: TripCreationSource;
  readonly page: number;
  readonly pageSize: number;
}

const tripSelection = {
  id: trips.id,
  bookingReference: trips.bookingReference,
  passengerName: trips.passengerName,
  pickupLocation: trips.pickupLocation,
  destination: trips.destination,
  scheduledAt: trips.scheduledAt,
  vehicleId: trips.vehicleId,
  vehicleSnapshot: trips.vehicleSnapshot,
  driverId: trips.driverId,
  driverNameSnapshot: trips.driverNameSnapshot,
  driverCodeSnapshot: trips.driverCodeSnapshot,
  driverSourceSnapshot: trips.driverSourceSnapshot,
  vendorId: trips.vendorId,
  vendorNameSnapshot: trips.vendorNameSnapshot,
  creationSource: trips.creationSource,
  status: trips.status,
  startedFeedbackAt: trips.startedFeedbackAt,
  createdAt: trips.createdAt,
  updatedAt: trips.updatedAt,
  archivedAt: trips.archivedAt,
};

export class TripService {
  constructor(private readonly db: AppDatabase) {}

  async createAdmin(input: CreateTripInput, actorAccountId: string) {
    return this.create(input, 'ADMIN_ASSIGNED', actorAccountId);
  }

  async createDriver(
    input: Omit<CreateTripInput, 'driverId'>,
    driverId: string,
    actorAccountId: string,
  ) {
    return this.create({ ...input, driverId }, 'DRIVER_ENTERED', actorAccountId);
  }

  async update(id: string, input: UpdateTripInput, actorAccountId: string) {
    const current = await this.get(id);
    if (current.status !== 'READY') {
      throw new AppError({
        code: 'TRIP_NOT_EDITABLE',
        message: 'Only a ready trip can be edited',
        statusCode: 409,
      });
    }

    const driver = await this.resolveDriver(input.driverId ?? current.driverId);
    const vehicle = await this.resolveVehicle(input.vehicleId ?? current.vehicleId);
    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(trips)
        .set({
          ...(input.bookingReference !== undefined
            ? { bookingReference: input.bookingReference.trim() }
            : {}),
          ...(input.passengerName !== undefined
            ? { passengerName: input.passengerName.trim() }
            : {}),
          ...(input.pickupLocation !== undefined
            ? { pickupLocation: input.pickupLocation.trim() }
            : {}),
          ...(input.destination !== undefined ? { destination: input.destination.trim() } : {}),
          ...(input.scheduledAt !== undefined ? { scheduledAt: new Date(input.scheduledAt) } : {}),
          vehicleId: vehicle.id,
          vehicleSnapshot: {
            registrationNumber: vehicle.registrationNumber,
            displayName: vehicle.displayName,
          },
          driverId: driver.id,
          driverNameSnapshot: driver.displayName,
          driverCodeSnapshot: driver.driverCode,
          driverSourceSnapshot: driver.sourceType,
          vendorId: driver.vendorId,
          vendorNameSnapshot: driver.vendorName,
          updatedAt: new Date(),
        })
        .where(and(eq(trips.id, id), eq(trips.status, 'READY')))
        .returning(tripSelection);
      if (!rows[0]) {
        throw new AppError({
          code: 'TRIP_NOT_EDITABLE',
          message: 'Only a ready trip can be edited',
          statusCode: 409,
        });
      }
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'TRIP_UPDATED',
        entityType: 'TRIP',
        entityId: id,
        metadata: { changedFields: Object.keys(input).sort().join(',') },
      });
      return rows;
    });
    return updated!;
  }

  async get(id: string, driverId?: string) {
    const filter = driverId
      ? and(eq(trips.id, id), eq(trips.driverId, driverId))
      : eq(trips.id, id);
    const [trip] = await this.db.select(tripSelection).from(trips).where(filter).limit(1);
    if (!trip) {
      throw new AppError({
        code: 'TRIP_NOT_FOUND',
        message: 'Trip was not found',
        statusCode: 404,
      });
    }
    return trip;
  }

  async list(input: ListTripsInput) {
    const conditions: SQL[] = [];
    conditions.push(input.status ? eq(trips.status, input.status) : ne(trips.status, 'ARCHIVED'));
    if (input.driverId) conditions.push(eq(trips.driverId, input.driverId));
    if (input.creationSource) conditions.push(eq(trips.creationSource, input.creationSource));
    const filter = and(...conditions);
    const offset = (input.page - 1) * input.pageSize;
    const [items, [total]] = await Promise.all([
      this.db
        .select(tripSelection)
        .from(trips)
        .where(filter)
        .orderBy(desc(trips.scheduledAt), desc(trips.createdAt))
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(trips).where(filter),
    ]);
    return { items, total: total?.value ?? 0 };
  }

  async archive(id: string, actorAccountId: string) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [trip] = await tx
        .update(trips)
        .set({ status: 'ARCHIVED', archivedAt: now, updatedAt: now })
        .where(eq(trips.id, id))
        .returning(tripSelection);
      if (!trip) {
        throw new AppError({
          code: 'TRIP_NOT_FOUND',
          message: 'Trip was not found',
          statusCode: 404,
        });
      }
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'TRIP_ARCHIVED',
        entityType: 'TRIP',
        entityId: id,
      });
      return trip;
    });
  }

  async startFeedback(id: string, driverId: string, actorAccountId: string) {
    const current = await this.get(id, driverId);
    if (current.status === 'FEEDBACK_STARTED') return current;
    if (current.status !== 'READY') {
      throw new AppError({
        code: 'TRIP_CANNOT_START_FEEDBACK',
        message: 'Feedback cannot be started for this trip',
        statusCode: 409,
      });
    }
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [trip] = await tx
        .update(trips)
        .set({ status: 'FEEDBACK_STARTED', startedFeedbackAt: now, updatedAt: now })
        .where(and(eq(trips.id, id), eq(trips.driverId, driverId), eq(trips.status, 'READY')))
        .returning(tripSelection);
      if (!trip) {
        const [currentTrip] = await tx
          .select(tripSelection)
          .from(trips)
          .where(and(eq(trips.id, id), eq(trips.driverId, driverId)))
          .limit(1);
        if (currentTrip?.status === 'FEEDBACK_STARTED') return currentTrip;
        throw new AppError({
          code: 'TRIP_CANNOT_START_FEEDBACK',
          message: 'Feedback cannot be started for this trip',
          statusCode: 409,
        });
      }
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'TRIP_FEEDBACK_STARTED',
        entityType: 'TRIP',
        entityId: id,
      });
      return trip;
    });
  }

  private async create(
    input: CreateTripInput,
    creationSource: TripCreationSource,
    actorAccountId: string,
  ) {
    const [driver, vehicle] = await Promise.all([
      this.resolveDriver(input.driverId),
      this.resolveVehicle(input.vehicleId),
    ]);
    return this.db.transaction(async (tx) => {
      const [trip] = await tx
        .insert(trips)
        .values({
          bookingReference: input.bookingReference.trim(),
          passengerName: input.passengerName.trim(),
          pickupLocation: input.pickupLocation.trim(),
          destination: input.destination.trim(),
          scheduledAt: new Date(input.scheduledAt),
          vehicleId: vehicle.id,
          vehicleSnapshot: {
            registrationNumber: vehicle.registrationNumber,
            displayName: vehicle.displayName,
          },
          driverId: driver.id,
          driverNameSnapshot: driver.displayName,
          driverCodeSnapshot: driver.driverCode,
          driverSourceSnapshot: driver.sourceType,
          vendorId: driver.vendorId,
          vendorNameSnapshot: driver.vendorName,
          creationSource,
          createdByAccountId: actorAccountId,
        })
        .returning(tripSelection);
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'TRIP_CREATED',
        entityType: 'TRIP',
        entityId: trip!.id,
        metadata: { creationSource },
      });
      return trip!;
    });
  }

  private async resolveDriver(id: string) {
    const [driver] = await this.db
      .select({
        id: drivers.id,
        displayName: authAccounts.displayName,
        driverCode: drivers.driverCode,
        sourceType: drivers.sourceType,
        vendorId: drivers.vendorId,
        vendorName: vendors.name,
        vendorStatus: vendors.status,
      })
      .from(drivers)
      .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
      .leftJoin(vendors, eq(vendors.id, drivers.vendorId))
      .where(and(eq(drivers.id, id), eq(authAccounts.status, 'ACTIVE')))
      .limit(1);
    if (!driver || (driver.sourceType === 'OUTSOURCED' && driver.vendorStatus !== 'ACTIVE')) {
      throw new AppError({
        code: 'ACTIVE_DRIVER_NOT_FOUND',
        message: 'The selected driver is unavailable',
        statusCode: 400,
      });
    }
    return driver;
  }

  private async resolveVehicle(id: string) {
    const [vehicle] = await this.db
      .select({
        id: vehicles.id,
        registrationNumber: vehicles.registrationNumber,
        displayName: vehicles.displayName,
      })
      .from(vehicles)
      .where(and(eq(vehicles.id, id), eq(vehicles.status, 'ACTIVE')))
      .limit(1);
    if (!vehicle) {
      throw new AppError({
        code: 'ACTIVE_VEHICLE_NOT_FOUND',
        message: 'The selected vehicle is unavailable',
        statusCode: 400,
      });
    }
    return vehicle;
  }
}
