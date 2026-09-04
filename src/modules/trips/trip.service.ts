import { and, asc, count, desc, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  auditEvents,
  authAccounts,
  bookingDriverEngagements,
  bookings,
  driverLeavePeriods,
  drivers,
  engagementFeedbackSections,
  trips,
  vehicles,
  vendors,
} from '../../database/schema/index.js';
import { AppError } from '../../shared/errors/app-error.js';
import { findPostgresError } from '../../shared/database/postgres-error.js';

type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];
type QueryDatabase = Pick<AppDatabase, 'select'>;

export type TripStatus = 'READY' | 'FEEDBACK_STARTED' | 'SUBMITTED' | 'ARCHIVED';
export type TripCreationSource = 'ADMIN_ASSIGNED' | 'DRIVER_ENTERED';
export type QuestionnairePurpose = 'ARRIVAL_EXPERIENCE' | 'DRIVER_FEEDBACK' | 'TOUR_EXPERIENCE';

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
  engagementId: trips.engagementId,
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
  feedbackPurposes: sql<QuestionnairePurpose[]>`coalesce((
    select json_agg("trip_sections"."purpose" order by case "trip_sections"."purpose"
      when 'ARRIVAL_EXPERIENCE' then 0
      when 'DRIVER_FEEDBACK' then 1
      when 'TOUR_EXPERIENCE' then 2
    end)
    from "engagement_feedback_sections" as "trip_sections"
    where "trip_sections"."engagement_id" = "trips"."engagement_id"
  ), '[]'::json)`,
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
          ...(bookingId !== current.bookingId ? [`booking:${current.bookingId}`] : []),
          `driver:${driverId}`,
          `vehicle:${vehicleId}`,
        ]);
        await this.ensureBookingScheduleEditable(tx, current.bookingId);
        if (bookingId !== current.bookingId)
          await this.ensureBookingScheduleEditable(tx, bookingId);
        await this.ensureTripEngagementEditable(tx, id);
        const booking = await this.resolveBooking(bookingId, tx);
        const driver = await this.resolveDriver(driverId, tx);
        const vehicle = await this.resolveVehicle(vehicleId, tx);
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
        await this.rebuildEngagements(tx, current.bookingId, actorAccountId);
        if (bookingId !== current.bookingId)
          await this.rebuildEngagements(tx, bookingId, actorAccountId);
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

  async listForEngagementIds(engagementIds: readonly string[]) {
    if (!engagementIds.length) return [];
    return this.db
      .select(tripSelection)
      .from(trips)
      .innerJoin(bookings, eq(bookings.id, trips.bookingId))
      .where(inArray(trips.engagementId, [...engagementIds]))
      .orderBy(asc(trips.scheduledAt), asc(trips.createdAt), asc(trips.id));
  }

  async archive(id: string, actorAccountId: string) {
    return this.db.transaction(async (tx) => {
      const current = await this.findTrip(tx, eq(trips.id, id));
      if (!current) {
        throw new AppError({
          code: 'TRIP_NOT_FOUND',
          message: 'Trip was not found',
          statusCode: 404,
        });
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${'booking:' + current.bookingId}, 0))`,
      );
      await this.ensureBookingScheduleEditable(tx, current.bookingId);
      await this.ensureTripEngagementEditable(tx, id);
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
      await this.rebuildEngagements(tx, current.bookingId, actorAccountId);
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
        await this.ensureBookingScheduleEditable(tx, input.bookingId);
        const booking = await this.resolveBooking(input.bookingId, tx);
        const driver = await this.resolveDriver(input.driverId, tx);
        const vehicle = await this.resolveVehicle(input.vehicleId, tx);
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
        await this.rebuildEngagements(tx, booking.id, actorAccountId);
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
    const driverConflict = await database
      .select({ id: trips.id })
      .from(trips)
      .where(and(overlap, eq(trips.driverId, driver.id)))
      .limit(1);
    const vehicleConflict = await database
      .select({ id: trips.id })
      .from(trips)
      .where(and(overlap, eq(trips.vehicleId, vehicleId)))
      .limit(1);
    const leave = await database
      .select({ id: driverLeavePeriods.id })
      .from(driverLeavePeriods)
      .where(
        and(
          eq(driverLeavePeriods.driverId, driver.id),
          lt(driverLeavePeriods.startsAt, schedule.scheduledEndAt),
          gt(driverLeavePeriods.endsAt, schedule.scheduledAt),
        ),
      )
      .limit(1);
    const assignedTrips = await database
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
      );

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

  private async ensureBookingScheduleEditable(database: AppTransaction, bookingId: string) {
    const [lockedTour] = await database
      .select({ id: bookingDriverEngagements.id })
      .from(bookingDriverEngagements)
      .innerJoin(
        engagementFeedbackSections,
        eq(engagementFeedbackSections.engagementId, bookingDriverEngagements.id),
      )
      .where(
        and(
          eq(bookingDriverEngagements.bookingId, bookingId),
          inArray(bookingDriverEngagements.status, ['FEEDBACK_STARTED', 'SUBMITTED']),
          eq(engagementFeedbackSections.purpose, 'TOUR_EXPERIENCE'),
        ),
      )
      .limit(1);
    if (lockedTour) {
      throw new AppError({
        code: 'BOOKING_SCHEDULE_LOCKED_BY_FEEDBACK',
        message: 'Trips cannot be changed after final tour feedback has started for this booking',
        statusCode: 409,
      });
    }
  }

  private async ensureTripEngagementEditable(database: AppTransaction, tripId: string) {
    const [engagement] = await database
      .select({ status: bookingDriverEngagements.status })
      .from(trips)
      .innerJoin(bookingDriverEngagements, eq(bookingDriverEngagements.id, trips.engagementId))
      .where(eq(trips.id, tripId))
      .limit(1);
    if (engagement && engagement.status !== 'READY') {
      throw new AppError({
        code: 'TRIP_ENGAGEMENT_LOCKED_BY_FEEDBACK',
        message: 'This trip belongs to an engagement whose passenger feedback has started',
        statusCode: 409,
      });
    }
  }

  private async rebuildEngagements(
    database: AppTransaction,
    bookingId: string,
    actorAccountId: string,
  ) {
    const lockedEngagements = await database
      .select({
        id: bookingDriverEngagements.id,
        sequenceNumber: bookingDriverEngagements.sequenceNumber,
      })
      .from(bookingDriverEngagements)
      .where(
        and(
          eq(bookingDriverEngagements.bookingId, bookingId),
          inArray(bookingDriverEngagements.status, ['FEEDBACK_STARTED', 'SUBMITTED']),
        ),
      )
      .orderBy(asc(bookingDriverEngagements.sequenceNumber));
    const readyEngagements = await database
      .select({ id: bookingDriverEngagements.id })
      .from(bookingDriverEngagements)
      .where(
        and(
          eq(bookingDriverEngagements.bookingId, bookingId),
          eq(bookingDriverEngagements.status, 'READY'),
        ),
      );
    const readyIds = readyEngagements.map((engagement) => engagement.id);
    if (readyIds.length) {
      await database
        .update(trips)
        .set({ engagementId: null })
        .where(inArray(trips.engagementId, readyIds));
    }
    await database
      .delete(bookingDriverEngagements)
      .where(
        and(
          eq(bookingDriverEngagements.bookingId, bookingId),
          eq(bookingDriverEngagements.status, 'READY'),
        ),
      );

    const scheduledTrips = await database
      .select()
      .from(trips)
      .where(
        and(
          eq(trips.bookingId, bookingId),
          ne(trips.status, 'ARCHIVED'),
          isNull(trips.engagementId),
        ),
      )
      .orderBy(asc(trips.scheduledAt), asc(trips.createdAt), asc(trips.id));
    if (lockedEngagements.length) {
      const lockedTrips = await database
        .select({
          scheduledAt: trips.scheduledAt,
          createdAt: trips.createdAt,
          id: trips.id,
        })
        .from(trips)
        .where(
          inArray(
            trips.engagementId,
            lockedEngagements.map((item) => item.id),
          ),
        )
        .orderBy(desc(trips.scheduledAt), desc(trips.createdAt), desc(trips.id))
        .limit(1);
      const lastLockedTrip = lockedTrips[0];
      const firstEditableTrip = scheduledTrips[0];
      if (
        lastLockedTrip &&
        firstEditableTrip &&
        compareTripOrder(firstEditableTrip, lastLockedTrip) <= 0
      ) {
        throw new AppError({
          code: 'BOOKING_FEEDBACK_SEQUENCE_CONFLICT',
          message: 'Future trips must remain after every engagement whose feedback has started',
          statusCode: 409,
        });
      }
      if (!scheduledTrips.length) {
        throw new AppError({
          code: 'BOOKING_FINAL_ENGAGEMENT_REQUIRED',
          message: 'At least one future engagement is required after previously started feedback',
          statusCode: 409,
        });
      }
    }
    const groups = deriveEngagementGroups(scheduledTrips);
    const sequenceOffset = lockedEngagements.at(-1)?.sequenceNumber ?? 0;

    for (const [index, group] of groups.entries()) {
      const firstTrip = group[0]!;
      const [engagement] = await database
        .insert(bookingDriverEngagements)
        .values({
          bookingId,
          sequenceNumber: sequenceOffset + index + 1,
          driverId: firstTrip.driverId,
          driverNameSnapshot: firstTrip.driverNameSnapshot,
          driverCodeSnapshot: firstTrip.driverCodeSnapshot,
          driverSourceSnapshot: firstTrip.driverSourceSnapshot,
          vendorId: firstTrip.vendorId,
          vendorNameSnapshot: firstTrip.vendorNameSnapshot,
        })
        .returning({ id: bookingDriverEngagements.id });
      if (!engagement) throw new Error('Engagement insert did not return a row');
      await database
        .update(trips)
        .set({ engagementId: engagement.id })
        .where(
          inArray(
            trips.id,
            group.map((trip) => trip.id),
          ),
        );

      const purposes: QuestionnairePurpose[] = ['DRIVER_FEEDBACK'];
      if (index === 0 && lockedEngagements.length === 0) purposes.unshift('ARRIVAL_EXPERIENCE');
      if (index === groups.length - 1) purposes.push('TOUR_EXPERIENCE');
      await database.insert(engagementFeedbackSections).values(
        purposes.map((purpose) => ({
          engagementId: engagement.id,
          bookingId,
          purpose,
          assignedByAccountId: actorAccountId,
        })),
      );
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
    const postgresError = findPostgresError(error, '23505');
    if (postgresError?.constraint === 'engagement_feedback_sections_booking_boundary_unique') {
      return new AppError({
        code: 'BOOKING_FEEDBACK_PURPOSE_ALREADY_ASSIGNED',
        message:
          'Arrival and tour feedback can each be assigned to only one engagement per booking',
        statusCode: 409,
      });
    }
    return error;
  }
}

export function deriveEngagementGroups<T extends { readonly driverId: string }>(
  chronologicallyOrderedTrips: readonly T[],
): T[][] {
  const groups: T[][] = [];
  for (const trip of chronologicallyOrderedTrips) {
    const current = groups.at(-1);
    if (current?.[0]?.driverId === trip.driverId) current.push(trip);
    else groups.push([trip]);
  }
  return groups;
}

function compareTripOrder(
  left: { readonly scheduledAt: Date; readonly createdAt: Date; readonly id: string },
  right: { readonly scheduledAt: Date; readonly createdAt: Date; readonly id: string },
): number {
  return (
    left.scheduledAt.getTime() - right.scheduledAt.getTime() ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
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
