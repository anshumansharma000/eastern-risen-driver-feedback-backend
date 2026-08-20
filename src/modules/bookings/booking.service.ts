import { and, asc, count, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { auditEvents, bookings, tripFeedbackSections, trips } from '../../database/schema/index.js';
import { findPostgresError } from '../../shared/database/postgres-error.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { FieldEncryptor } from '../../shared/security/field-encryption.js';

export type BookingStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'ARCHIVED';

export interface CreateBookingInput {
  readonly bookingReference: string;
  readonly tourName?: string | null;
  readonly fileNumber?: string | null;
  readonly passengerName: string;
  readonly passengerPhone: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly notes?: string | null;
}

export interface UpdateBookingInput {
  readonly bookingReference?: string;
  readonly tourName?: string | null;
  readonly fileNumber?: string | null;
  readonly passengerName?: string;
  readonly passengerPhone?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly notes?: string | null;
  readonly status?: Exclude<BookingStatus, 'ARCHIVED'>;
}

const bookingSelection = {
  id: bookings.id,
  bookingReference: bookings.bookingReference,
  tourName: bookings.tourName,
  fileNumber: bookings.fileNumber,
  passengerName: bookings.passengerName,
  passengerPhoneCiphertext: bookings.passengerPhoneCiphertext,
  startsAt: bookings.startsAt,
  endsAt: bookings.endsAt,
  status: bookings.status,
  notes: bookings.notes,
  // Keep both sides qualified: Drizzle strips qualifiers from interpolated columns
  // inside a scalar selection, which would otherwise compare trips.booking_id to
  // trips.id instead of the outer booking id.
  tripCount: sql<number>`(
    select count(*)::int
    from "trips" as "booking_trips"
    where "booking_trips"."booking_id" = "bookings"."id"
  )`,
  createdAt: bookings.createdAt,
  updatedAt: bookings.updatedAt,
  archivedAt: bookings.archivedAt,
};

export class BookingService {
  constructor(
    private readonly db: AppDatabase,
    private readonly encryptor: FieldEncryptor,
  ) {}

  async create(input: CreateBookingInput, actorAccountId: string) {
    const period = validatePeriod(input.startsAt, input.endsAt);
    try {
      const [booking] = await this.db
        .insert(bookings)
        .values({
          bookingReference: input.bookingReference.trim(),
          tourName: normalizeOptionalText(input.tourName),
          fileNumber: normalizeOptionalText(input.fileNumber),
          passengerName: input.passengerName.trim(),
          passengerPhoneCiphertext: this.encryptor.encrypt(input.passengerPhone),
          startsAt: period.startsAt,
          endsAt: period.endsAt,
          notes: input.notes?.trim() || null,
          createdByAccountId: actorAccountId,
        })
        .returning();
      await this.db.insert(auditEvents).values({
        actorAccountId,
        action: 'BOOKING_CREATED',
        entityType: 'BOOKING',
        entityId: booking!.id,
      });
      return this.get(booking!.id);
    } catch (error) {
      throw mapBookingError(error);
    }
  }

  async update(id: string, input: UpdateBookingInput, actorAccountId: string) {
    const current = await this.get(id);
    if (current.status === 'ARCHIVED') notEditable();
    const period = validatePeriod(
      input.startsAt ?? current.startsAt.toISOString(),
      input.endsAt ?? current.endsAt.toISOString(),
    );
    const [outsideTrip] = await this.db
      .select({ id: trips.id })
      .from(trips)
      .where(
        and(
          eq(trips.bookingId, id),
          ne(trips.status, 'ARCHIVED'),
          sql`(${trips.scheduledAt} < ${period.startsAt} OR ${trips.scheduledEndAt} > ${period.endsAt})`,
        ),
      )
      .limit(1);
    if (outsideTrip) {
      throw new AppError({
        code: 'BOOKING_PERIOD_EXCLUDES_TRIPS',
        message: 'The booking period must contain all active trips',
        statusCode: 409,
      });
    }
    if (input.status === 'COMPLETED') await this.validateTourFeedbackConfiguration(id);
    try {
      const [updated] = await this.db
        .update(bookings)
        .set({
          ...(input.bookingReference !== undefined
            ? { bookingReference: input.bookingReference.trim() }
            : {}),
          ...(input.tourName !== undefined
            ? { tourName: normalizeOptionalText(input.tourName) }
            : {}),
          ...(input.fileNumber !== undefined
            ? { fileNumber: normalizeOptionalText(input.fileNumber) }
            : {}),
          ...(input.passengerName !== undefined
            ? { passengerName: input.passengerName.trim() }
            : {}),
          ...(input.passengerPhone !== undefined
            ? { passengerPhoneCiphertext: this.encryptor.encrypt(input.passengerPhone) }
            : {}),
          startsAt: period.startsAt,
          endsAt: period.endsAt,
          ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(bookings.id, id), ne(bookings.status, 'ARCHIVED')))
        .returning({ id: bookings.id });
      if (!updated) notEditable();
      await this.db.insert(auditEvents).values({
        actorAccountId,
        action: 'BOOKING_UPDATED',
        entityType: 'BOOKING',
        entityId: id,
        metadata: { changedFields: Object.keys(input).sort().join(',') },
      });
      return this.get(id);
    } catch (error) {
      throw mapBookingError(error);
    }
  }

  async get(id: string) {
    const [booking] = await this.db
      .select(bookingSelection)
      .from(bookings)
      .where(eq(bookings.id, id))
      .limit(1);
    if (!booking) {
      throw new AppError({
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking was not found',
        statusCode: 404,
      });
    }
    return this.withPassengerPhone(booking);
  }

  async list(input: { status?: BookingStatus; page: number; pageSize: number }) {
    const conditions: SQL[] = [
      input.status ? eq(bookings.status, input.status) : ne(bookings.status, 'ARCHIVED'),
    ];
    const filter = and(...conditions);
    const offset = (input.page - 1) * input.pageSize;
    const [items, [total]] = await Promise.all([
      this.db
        .select(bookingSelection)
        .from(bookings)
        .where(filter)
        .orderBy(desc(bookings.startsAt), desc(bookings.createdAt), desc(bookings.id))
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(bookings).where(filter),
    ]);
    return { items: items.map((item) => this.withPassengerPhone(item)), total: total?.value ?? 0 };
  }

  async archive(id: string, actorAccountId: string) {
    const now = new Date();
    const [booking] = await this.db
      .update(bookings)
      .set({ status: 'ARCHIVED', archivedAt: now, updatedAt: now })
      .where(eq(bookings.id, id))
      .returning({ id: bookings.id });
    if (!booking) {
      throw new AppError({
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking was not found',
        statusCode: 404,
      });
    }
    await this.db.insert(auditEvents).values({
      actorAccountId,
      action: 'BOOKING_ARCHIVED',
      entityType: 'BOOKING',
      entityId: id,
    });
    return this.get(id);
  }

  private withPassengerPhone<T extends { passengerPhoneCiphertext: string | null }>(booking: T) {
    const { passengerPhoneCiphertext, ...rest } = booking;
    return {
      ...rest,
      passengerPhone: passengerPhoneCiphertext
        ? this.encryptor.decrypt(passengerPhoneCiphertext)
        : null,
    };
  }

  private async validateTourFeedbackConfiguration(bookingId: string) {
    const [bookingTrips, [tourSection]] = await Promise.all([
      this.db
        .select({ id: trips.id })
        .from(trips)
        .where(and(eq(trips.bookingId, bookingId), ne(trips.status, 'ARCHIVED')))
        .orderBy(asc(trips.scheduledAt), asc(trips.createdAt), asc(trips.id)),
      this.db
        .select({ tripId: tripFeedbackSections.tripId })
        .from(tripFeedbackSections)
        .where(
          and(
            eq(tripFeedbackSections.bookingId, bookingId),
            eq(tripFeedbackSections.purpose, 'TOUR_EXPERIENCE'),
          ),
        )
        .limit(1),
    ]);
    if (!bookingTrips.length || !tourSection) {
      throw new AppError({
        code: 'BOOKING_TOUR_FEEDBACK_MISSING',
        message: 'Tour experience feedback must be assigned before completing the booking',
        statusCode: 409,
      });
    }
    if (tourSection.tripId !== bookingTrips.at(-1)!.id) {
      throw new AppError({
        code: 'BOOKING_TOUR_FEEDBACK_NOT_ON_LAST_TRIP',
        message: 'Tour experience feedback must be assigned to the last scheduled trip',
        statusCode: 409,
      });
    }
  }
}

function normalizeOptionalText(value: string | null | undefined) {
  return value?.trim() || null;
}

function validatePeriod(startsAtInput: string, endsAtInput: string) {
  const startsAt = new Date(startsAtInput);
  const endsAt = new Date(endsAtInput);
  if (endsAt <= startsAt) {
    throw new AppError({
      code: 'INVALID_BOOKING_PERIOD',
      message: 'Booking end time must be after its start time',
      statusCode: 400,
    });
  }
  return { startsAt, endsAt };
}

function notEditable(): never {
  throw new AppError({
    code: 'BOOKING_NOT_EDITABLE',
    message: 'An archived booking cannot be edited',
    statusCode: 409,
  });
}

function mapBookingError(error: unknown): unknown {
  if (findPostgresError(error, '23505')?.constraint === 'bookings_reference_unique') {
    return new AppError({
      code: 'BOOKING_REFERENCE_ALREADY_EXISTS',
      message: 'This booking reference is already in use',
      statusCode: 409,
    });
  }
  return error;
}
