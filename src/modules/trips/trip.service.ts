import { and, asc, count, desc, eq, gt, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  auditEvents,
  authAccounts,
  bookings,
  driverLeavePeriods,
  drivers,
  trips,
  vehicles,
  vendors,
} from '../../database/schema/index.js';
import { AppError } from '../../shared/errors/app-error.js';

type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];
type QueryDatabase = Pick<AppDatabase, 'select'>;

export type TripStatus = 'READY' | 'FEEDBACK_STARTED' | 'SUBMITTED' | 'ARCHIVED';
export type TripCreationSource = 'ADMIN_ASSIGNED' | 'DRIVER_ENTERED';

export interface CreateTripInput {
  readonly bookingId: string;
  readonly pickupLocation: string;
  readonly destination: string;
  readonly scheduledAt: string;
  readonly scheduledEndAt: string;
  readonly vehicleId: string;
  readonly driverId: string;
}

export interface UpdateTripInput {
  readonly bookingId?: string;
  readonly pickupLocation?: string;
  readonly destination?: string;
  readonly scheduledAt?: string;
  readonly scheduledEndAt?: string;
  readonly vehicleId?: string;
  readonly driverId?: string;
}

export interface ListTripsInput {
  readonly status?: TripStatus;
  readonly driverId?: string;
  readonly creationSource?: TripCreationSource;
  readonly bookingId?: string;
  readonly page: number;
  readonly pageSize: number;
}

const tripSelection = {
  id: trips.id,
  bookingId: trips.bookingId,
  bookingReference: bookings.bookingReference,
  passengerName: bookings.passengerName,
  pickupLocation: trips.pickupLocation,
  destination: trips.destination,
  scheduledAt: trips.scheduledAt,
  scheduledEndAt: trips.scheduledEndAt,
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

    const bookingId = input.bookingId ?? current.bookingId;
    const driverId = input.driverId ?? current.driverId;
    const vehicleId = input.vehicleId ?? current.vehicleId;
    const schedule = this.validateBasicAssignment({
      pickupLocation: input.pickupLocation ?? current.pickupLocation,
      destination: input.destination ?? current.destination,
      scheduledAt: input.scheduledAt ?? current.scheduledAt.toISOString(),
      scheduledEndAt: input.scheduledEndAt ?? current.scheduledEndAt.toISOString(),
    });
    try {
      const [updated] = await this.db.transaction(async (tx) => {
        await this.acquireAssignmentLocks(tx, [
          `booking:${bookingId}`,
          `driver:${driverId}`,
          `vehicle:${vehicleId}`,
        ]);
        const [booking, driver, vehicle] = await Promise.all([
          this.resolveBooking(bookingId, tx),
          this.resolveDriver(driverId, tx),
          this.resolveVehicle(vehicleId, tx),
        ]);
        await this.validateAssignment(tx, driver, vehicle.id, schedule, id);
        this.validateBookingPeriod(booking, schedule);
        const rows = await tx
          .update(trips)
          .set({
            bookingId: booking.id,
            ...(input.pickupLocation !== undefined
              ? { pickupLocation: input.pickupLocation.trim() }
              : {}),
            ...(input.destination !== undefined ? { destination: input.destination.trim() } : {}),
            ...(input.scheduledAt !== undefined
              ? { scheduledAt: new Date(input.scheduledAt) }
              : {}),
            ...(input.scheduledEndAt !== undefined
              ? { scheduledEndAt: new Date(input.scheduledEndAt) }
              : {}),
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
          .returning({ id: trips.id });
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
        return [await this.findTrip(tx, eq(trips.id, id))];
      });
      return updated!;
    } catch (error) {
      throw this.mapAssignmentDatabaseError(error);
    }
  }

  async get(id: string, driverId?: string) {
    const filter = driverId
      ? and(eq(trips.id, id), eq(trips.driverId, driverId))
      : eq(trips.id, id);
    const trip = await this.findTrip(this.db, filter);
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
    if (input.bookingId) conditions.push(eq(trips.bookingId, input.bookingId));
    const filter = and(...conditions);
    const offset = (input.page - 1) * input.pageSize;
    const [items, [total]] = await Promise.all([
      this.db
        .select(tripSelection)
        .from(trips)
        .innerJoin(bookings, eq(bookings.id, trips.bookingId))
        .where(filter)
        .orderBy(desc(trips.scheduledAt), desc(trips.createdAt), desc(trips.id))
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(trips).where(filter),
    ]);
    return { items, total: total?.value ?? 0 };
  }

  async listForBooking(bookingId: string) {
    return this.db
      .select(tripSelection)
      .from(trips)
      .innerJoin(bookings, eq(bookings.id, trips.bookingId))
      .where(eq(trips.bookingId, bookingId))
      .orderBy(asc(trips.scheduledAt), asc(trips.createdAt), asc(trips.id));
  }

  async archive(id: string, actorAccountId: string) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [updated] = await tx
        .update(trips)
        .set({ status: 'ARCHIVED', archivedAt: now, updatedAt: now })
        .where(eq(trips.id, id))
        .returning({ id: trips.id });
      if (!updated) {
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
      return (await this.findTrip(tx, eq(trips.id, id)))!;
    });
  }

  private async create(
    input: CreateTripInput,
    creationSource: TripCreationSource,
    actorAccountId: string,
  ) {
    const schedule = this.validateBasicAssignment(input);
    try {
      return await this.db.transaction(async (tx) => {
        await this.acquireAssignmentLocks(tx, [
          `booking:${input.bookingId}`,
          `driver:${input.driverId}`,
          `vehicle:${input.vehicleId}`,
        ]);
        const [booking, driver, vehicle] = await Promise.all([
          this.resolveBooking(input.bookingId, tx),
          this.resolveDriver(input.driverId, tx),
          this.resolveVehicle(input.vehicleId, tx),
        ]);
        this.validateBookingPeriod(booking, schedule);
        await this.validateAssignment(tx, driver, vehicle.id, schedule);
        const [created] = await tx
          .insert(trips)
          .values({
            bookingId: booking.id,
            pickupLocation: input.pickupLocation.trim(),
            destination: input.destination.trim(),
            scheduledAt: new Date(input.scheduledAt),
            scheduledEndAt: new Date(input.scheduledEndAt),
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
          .returning({ id: trips.id });
        const trip = await this.findTrip(tx, eq(trips.id, created!.id));
        await tx.insert(auditEvents).values({
          actorAccountId,
          action: 'TRIP_CREATED',
          entityType: 'TRIP',
          entityId: trip!.id,
          metadata: { creationSource },
        });
        return trip!;
      });
    } catch (error) {
      throw this.mapAssignmentDatabaseError(error);
    }
  }

  private async resolveDriver(id: string, database: QueryDatabase = this.db) {
    const [driver] = await database
      .select({
        id: drivers.id,
        displayName: authAccounts.displayName,
        driverCode: drivers.driverCode,
        sourceType: drivers.sourceType,
        vendorId: drivers.vendorId,
        vendorName: vendors.name,
        vendorStatus: vendors.status,
        assignmentEnabled: drivers.assignmentEnabled,
        shiftStartTime: drivers.shiftStartTime,
        shiftEndTime: drivers.shiftEndTime,
        timeZone: drivers.timeZone,
        maxDailyDutyMinutes: drivers.maxDailyDutyMinutes,
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

  private async findTrip(database: QueryDatabase, filter: SQL | undefined) {
    const [trip] = await database
      .select(tripSelection)
      .from(trips)
      .innerJoin(bookings, eq(bookings.id, trips.bookingId))
      .where(filter)
      .limit(1);
    return trip;
  }

  private async resolveBooking(id: string, database: QueryDatabase = this.db) {
    const [booking] = await database
      .select({ id: bookings.id, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
      .from(bookings)
      .where(and(eq(bookings.id, id), eq(bookings.status, 'ACTIVE')))
      .limit(1);
    if (!booking) {
      throw new AppError({
        code: 'ACTIVE_BOOKING_NOT_FOUND',
        message: 'The selected booking is unavailable',
        statusCode: 400,
      });
    }
    return booking;
  }

  private validateBookingPeriod(
    booking: Awaited<ReturnType<TripService['resolveBooking']>>,
    schedule: { scheduledAt: Date; scheduledEndAt: Date },
  ) {
    if (schedule.scheduledAt < booking.startsAt || schedule.scheduledEndAt > booking.endsAt) {
      throw new AppError({
        code: 'TRIP_OUTSIDE_BOOKING_PERIOD',
        message: 'The trip must fall within the booking period',
        statusCode: 409,
      });
    }
  }

  private async resolveVehicle(id: string, database: QueryDatabase = this.db) {
    const [vehicle] = await database
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

  private validateBasicAssignment(input: {
    pickupLocation: string;
    destination: string;
    scheduledAt: string;
    scheduledEndAt: string;
  }) {
    const scheduledAt = new Date(input.scheduledAt);
    const scheduledEndAt = new Date(input.scheduledEndAt);
    if (scheduledAt <= new Date()) {
      throw new AppError({
        code: 'TRIP_CANNOT_BE_SCHEDULED_IN_PAST',
        message: 'A trip must be scheduled in the future',
        statusCode: 400,
      });
    }
    if (scheduledEndAt <= scheduledAt) {
      throw new AppError({
        code: 'INVALID_TRIP_SCHEDULE',
        message: 'Trip end time must be after its start time',
        statusCode: 400,
      });
    }
    if (normalizeComparable(input.pickupLocation) === normalizeComparable(input.destination)) {
      throw new AppError({
        code: 'TRIP_LOCATIONS_MUST_DIFFER',
        message: 'Pickup and destination must be different',
        statusCode: 400,
      });
    }
    return { scheduledAt, scheduledEndAt };
  }

  private async validateAssignment(
    database: AppTransaction,
    driver: Awaited<ReturnType<TripService['resolveDriver']>>,
    vehicleId: string,
    schedule: { scheduledAt: Date; scheduledEndAt: Date },
    excludedTripId?: string,
  ) {
    if (!driver.assignmentEnabled) {
      throw new AppError({
        code: 'DRIVER_NOT_AVAILABLE_FOR_ASSIGNMENT',
        message: 'The selected driver is not available for assignment',
        statusCode: 409,
      });
    }
    this.validateShift(driver, schedule);

    const activeTrip = ne(trips.status, 'ARCHIVED');
    const excludeCurrent = excludedTripId ? ne(trips.id, excludedTripId) : undefined;
    const overlap = and(
      activeTrip,
      lt(trips.scheduledAt, schedule.scheduledEndAt),
      gt(trips.scheduledEndAt, schedule.scheduledAt),
      excludeCurrent,
    );
    const [driverConflict, vehicleConflict, leave, assignedTrips] = await Promise.all([
      database
        .select({ id: trips.id })
        .from(trips)
        .where(and(overlap, eq(trips.driverId, driver.id)))
        .limit(1),
      database
        .select({ id: trips.id })
        .from(trips)
        .where(and(overlap, eq(trips.vehicleId, vehicleId)))
        .limit(1),
      database
        .select({ id: driverLeavePeriods.id })
        .from(driverLeavePeriods)
        .where(
          and(
            eq(driverLeavePeriods.driverId, driver.id),
            lt(driverLeavePeriods.startsAt, schedule.scheduledEndAt),
            gt(driverLeavePeriods.endsAt, schedule.scheduledAt),
          ),
        )
        .limit(1),
      database
        .select({
          id: trips.id,
          scheduledAt: trips.scheduledAt,
          scheduledEndAt: trips.scheduledEndAt,
        })
        .from(trips)
        .where(
          and(
            eq(trips.driverId, driver.id),
            activeTrip,
            excludedTripId ? ne(trips.id, excludedTripId) : undefined,
          ),
        ),
    ]);

    if (driverConflict[0]) {
      throw new AppError({
        code: 'DRIVER_SCHEDULE_CONFLICT',
        message: 'The selected driver already has an overlapping trip',
        statusCode: 409,
      });
    }
    if (vehicleConflict[0]) {
      throw new AppError({
        code: 'VEHICLE_SCHEDULE_CONFLICT',
        message: 'The selected vehicle already has an overlapping trip',
        statusCode: 409,
      });
    }
    if (leave[0]) {
      throw new AppError({
        code: 'DRIVER_ON_LEAVE',
        message: 'The selected driver is on leave during this trip',
        statusCode: 409,
      });
    }

    const dutyDate = localDateKey(schedule.scheduledAt, driver.timeZone);
    const assignedMinutes = assignedTrips
      .filter((trip) => localDateKey(trip.scheduledAt, driver.timeZone) === dutyDate)
      .reduce(
        (total, trip) =>
          total + (trip.scheduledEndAt.getTime() - trip.scheduledAt.getTime()) / 60_000,
        0,
      );
    const requestedMinutes =
      (schedule.scheduledEndAt.getTime() - schedule.scheduledAt.getTime()) / 60_000;
    if (assignedMinutes + requestedMinutes > driver.maxDailyDutyMinutes) {
      throw new AppError({
        code: 'DRIVER_DAILY_DUTY_LIMIT_EXCEEDED',
        message: 'This trip would exceed the driver’s daily duty-hours limit',
        statusCode: 409,
      });
    }
  }

  private async acquireAssignmentLocks(database: AppTransaction, keys: string[]) {
    for (const key of keys.map(normalizeComparable).sort()) {
      await database.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    }
  }

  private validateShift(
    driver: Awaited<ReturnType<TripService['resolveDriver']>>,
    schedule: { scheduledAt: Date; scheduledEndAt: Date },
  ) {
    if (!driver.shiftStartTime || !driver.shiftEndTime) return;
    const start = localDateTime(schedule.scheduledAt, driver.timeZone);
    const end = localDateTime(schedule.scheduledEndAt, driver.timeZone);
    const shiftStartMilliseconds = parseTimeMilliseconds(driver.shiftStartTime);
    const shiftEndMilliseconds = parseTimeMilliseconds(driver.shiftEndTime);
    const startDay = Date.UTC(start.year, start.month - 1, start.day);
    const startWallTime = startDay + start.milliseconds;
    const endWallTime = Date.UTC(end.year, end.month - 1, end.day) + end.milliseconds;
    const overnight = shiftEndMilliseconds < shiftStartMilliseconds;
    let shiftAnchorDay = startDay;
    if (overnight && start.milliseconds < shiftEndMilliseconds) shiftAnchorDay -= 86_400_000;
    const shiftStart = shiftAnchorDay + shiftStartMilliseconds;
    const shiftEnd = shiftAnchorDay + (overnight ? 86_400_000 : 0) + shiftEndMilliseconds;
    if (startWallTime < shiftStart || endWallTime > shiftEnd) {
      throw new AppError({
        code: 'TRIP_OUTSIDE_DRIVER_SHIFT',
        message: 'The trip falls outside the selected driver’s shift',
        statusCode: 409,
      });
    }
  }

  private mapAssignmentDatabaseError(error: unknown): unknown {
    return error;
  }
}

function normalizeComparable(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function parseTimeMilliseconds(value: string): number {
  const [hours, minutes, seconds = 0] = value.split(':').map(Number);
  return ((hours! * 60 + minutes!) * 60 + seconds) * 1000;
}

function localDateTime(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)!.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    milliseconds: ((value('hour') * 60 + value('minute')) * 60 + value('second')) * 1000,
  };
}

function localDateKey(date: Date, timeZone: string): string {
  const local = localDateTime(date, timeZone);
  return `${local.year}-${local.month}-${local.day}`;
}
