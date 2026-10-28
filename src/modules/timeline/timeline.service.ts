import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  authAccounts,
  auditEvents,
  bookings,
  drivers,
  driverBookingLinks,
  driverLinkTrips,
  timelineEvents,
  timelinePhotos,
  timelineProgress,
  trips,
} from '../../database/schema/index.js';
import type {
  EventLocation,
  MilestoneType,
  OperationalStatus,
} from '../../database/schema/timeline.js';
import type { FieldEncryptor } from '../../shared/security/field-encryption.js';
import {
  InvalidStoredPhotoError,
  type AcceptedPhotoContentType,
  type PhotoStorage,
} from '../../shared/storage/photo-storage.js';
import { nextProgress, timelineError, validateEventTimes } from './timeline.rules.js';

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];
export type TimelineActor = { driverId: string; accountId: string } | { token: string };
export interface CreateEventInput {
  clientEventId: string;
  tripId: string;
  assignmentVersion: number;
  type: MilestoneType;
  occurredAt: string;
  recordedAt: string;
  submissionMode: 'ONLINE' | 'OFFLINE_SYNC';
  note?: string;
  location?: EventLocation;
  photoIds?: string[];
  correctsEventId?: string;
  correctionReason?: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hours = (value: number) => value * 3_600_000;

export class TimelineService {
  constructor(
    private readonly db: AppDatabase,
    private readonly encryptor: FieldEncryptor,
    private readonly storage: PhotoStorage,
    private readonly driverUrl: string | null,
    private readonly now = () => new Date(),
  ) {}

  private async lockBooking(tx: Tx, bookingId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'booking:' + bookingId}, 0))`,
    );
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for('update');
    if (!booking) timelineError('BOOKING_NOT_FOUND', 'Booking was not found', 404);
    return booking;
  }

  async issueLink(
    bookingId: string,
    driverId: string,
    accountId: string,
    input: { expiresAt?: string; regenerate?: boolean },
  ) {
    if (!this.driverUrl)
      timelineError(
        'DRIVER_LINK_URL_NOT_CONFIGURED',
        'Configure DRIVER_BOOKING_URL before sharing driver links',
        503,
      );
    return this.db.transaction(async (tx) => {
      const booking = await this.lockBooking(tx, bookingId);
      if (!['ACTIVE', 'COMPLETED'].includes(booking.status))
        timelineError('BOOKING_NOT_AVAILABLE', 'This booking is unavailable for driver access');
      await this.activeDriver(tx, driverId);
      const assignments = await tx
        .select({ tripId: trips.id, assignmentVersion: trips.assignmentVersion })
        .from(trips)
        .where(
          and(
            eq(trips.bookingId, bookingId),
            eq(trips.driverId, driverId),
            ne(trips.status, 'ARCHIVED'),
          ),
        );
      if (!assignments.length)
        timelineError(
          'DRIVER_BOOKING_NOT_ASSIGNED',
          'Driver has no active trips in this booking',
          403,
        );
      const now = this.now();
      const [existing] = await tx
        .select()
        .from(driverBookingLinks)
        .where(
          and(
            eq(driverBookingLinks.bookingId, bookingId),
            eq(driverBookingLinks.driverId, driverId),
            isNull(driverBookingLinks.revokedAt),
          ),
        )
        .orderBy(desc(driverBookingLinks.createdAt))
        .limit(1);
      const expiresAt = input.expiresAt
        ? new Date(input.expiresAt)
        : existing && existing.expiresAt > now && !input.regenerate
          ? existing.expiresAt
          : new Date(booking.endsAt.getTime() + hours(24));
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt <= now ||
        expiresAt.getTime() > Math.max(now.getTime(), booking.endsAt.getTime()) + hours(24 * 30)
      )
        timelineError(
          'DRIVER_LINK_EXPIRY_INVALID',
          'Expiry must be in the future and within 30 days of the booking end or today',
          400,
        );
      let link;
      let token: string;
      if (existing && existing.expiresAt > now && !input.regenerate) {
        token = this.encryptor.decrypt(existing.tokenCiphertext);
        [link] = await tx
          .update(driverBookingLinks)
          .set({ expiresAt })
          .where(eq(driverBookingLinks.id, existing.id))
          .returning();
        await tx.delete(driverLinkTrips).where(eq(driverLinkTrips.linkId, existing.id));
      } else {
        await tx
          .update(driverBookingLinks)
          .set({ revokedAt: now })
          .where(
            and(
              eq(driverBookingLinks.bookingId, bookingId),
              eq(driverBookingLinks.driverId, driverId),
              isNull(driverBookingLinks.revokedAt),
            ),
          );
        token = randomBytes(32).toString('base64url');
        [link] = await tx
          .insert(driverBookingLinks)
          .values({
            bookingId,
            driverId,
            tokenHash: hash(token),
            tokenCiphertext: this.encryptor.encrypt(token),
            expiresAt,
            createdByAccountId: accountId,
          })
          .returning();
      }
      if (!link) throw new Error('Driver link mutation did not return a record');
      await tx.insert(driverLinkTrips).values(assignments.map((a) => ({ ...a, linkId: link.id })));
      await tx.insert(auditEvents).values({
        actorAccountId: accountId,
        action: 'DRIVER_BOOKING_LINK_ISSUED',
        entityType: 'BOOKING',
        entityId: bookingId,
        metadata: { driverId, linkId: link.id, regenerated: !!input.regenerate },
      });
      const url = new URL(this.driverUrl!);
      url.hash = new URLSearchParams({ token }).toString();
      return {
        id: link.id,
        bookingId,
        driverId,
        expiresAt: expiresAt.toISOString(),
        link: url.toString(),
      };
    });
  }

  async revokeLink(bookingId: string, driverId: string, accountId: string) {
    await this.db.transaction(async (tx) => {
      await this.lockBooking(tx, bookingId);
      await tx
        .update(driverBookingLinks)
        .set({ revokedAt: this.now() })
        .where(
          and(
            eq(driverBookingLinks.bookingId, bookingId),
            eq(driverBookingLinks.driverId, driverId),
            isNull(driverBookingLinks.revokedAt),
          ),
        );
      await tx.insert(auditEvents).values({
        actorAccountId: accountId,
        action: 'DRIVER_BOOKING_LINK_REVOKED',
        entityType: 'BOOKING',
        entityId: bookingId,
        metadata: { driverId },
      });
    });
  }

  private async activeDriver(tx: Tx, driverId: string, accountId?: string) {
    const [driver] = await tx
      .select({
        id: drivers.id,
        accountId: drivers.accountId,
        displayName: authAccounts.displayName,
      })
      .from(drivers)
      .innerJoin(authAccounts, eq(authAccounts.id, drivers.accountId))
      .where(
        and(
          eq(drivers.id, driverId),
          eq(authAccounts.status, 'ACTIVE'),
          eq(authAccounts.role, 'DRIVER'),
        ),
      );
    if (!driver || (accountId && driver.accountId !== accountId))
      timelineError('DRIVER_ACCESS_REQUIRED', 'Active driver access is required', 403);
    return driver;
  }

  private async resolveActor(tx: Tx, actor: TimelineActor) {
    if ('token' in actor) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(actor.token))
        timelineError('DRIVER_LINK_INVALID', 'Driver link is invalid or expired', 401);
      const [link] = await tx
        .select()
        .from(driverBookingLinks)
        .where(eq(driverBookingLinks.tokenHash, hash(actor.token)));
      if (!link || link.revokedAt || link.expiresAt <= this.now())
        timelineError('DRIVER_LINK_INVALID', 'Driver link is invalid or expired', 401);
      const driver = await this.activeDriver(tx, link.driverId);
      return {
        driverId: driver.id,
        accountId: null,
        linkId: link.id,
        bookingId: link.bookingId,
        expiresAt: link.expiresAt,
      };
    }
    await this.activeDriver(tx, actor.driverId, actor.accountId);
    return {
      driverId: actor.driverId,
      accountId: actor.accountId,
      linkId: null,
      bookingId: null,
      expiresAt: null,
    };
  }

  private async authorisedTrip(
    tx: Tx,
    actor: TimelineActor,
    tripId: string,
    assignmentVersion?: number,
  ) {
    const [initial] = await tx
      .select({ bookingId: trips.bookingId })
      .from(trips)
      .where(eq(trips.id, tripId));
    if (!initial) timelineError('TRIP_NOT_FOUND', 'Trip was not found', 404);
    const booking = await this.lockBooking(tx, initial.bookingId);
    const access = await this.resolveActor(tx, actor);
    if (!['ACTIVE', 'COMPLETED'].includes(booking.status))
      timelineError('BOOKING_NOT_AVAILABLE', 'This booking no longer accepts driver updates', 403);
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).for('update');
    if (
      !trip ||
      trip.bookingId !== initial.bookingId ||
      trip.status === 'ARCHIVED' ||
      trip.driverId !== access.driverId ||
      (access.bookingId && access.bookingId !== trip.bookingId)
    )
      timelineError('TRIP_ACCESS_DENIED', 'This trip is not authorised for this driver', 403);
    if (assignmentVersion !== undefined && trip.assignmentVersion !== assignmentVersion)
      timelineError(
        'TRIP_ASSIGNMENT_CHANGED',
        'Assignment changed; keep queued updates for administrator review',
      );
    if (access.linkId) {
      const [grant] = await tx
        .select()
        .from(driverLinkTrips)
        .where(
          and(
            eq(driverLinkTrips.linkId, access.linkId),
            eq(driverLinkTrips.tripId, trip.id),
            eq(driverLinkTrips.assignmentVersion, trip.assignmentVersion),
          ),
        );
      if (!grant)
        timelineError(
          'TRIP_ACCESS_DENIED',
          'This driver link does not authorise the current trip assignment',
          403,
        );
    }
    return { trip, booking, access };
  }

  private reportingDeadline(booking: typeof bookings.$inferSelect, accessExpiry: Date | null) {
    // An explicitly extended link also extends its reporting window. Logged-in drivers use the latest active extension.
    return new Date(Math.max(booking.endsAt.getTime() + hours(24), accessExpiry?.getTime() ?? 0));
  }
  private async checkReportingWindow(
    tx: Tx,
    booking: typeof bookings.$inferSelect,
    access: Awaited<ReturnType<TimelineService['resolveActor']>>,
  ) {
    let expiry = access.expiresAt;
    if (!access.linkId) {
      const [extension] = await tx
        .select({ expiresAt: driverBookingLinks.expiresAt })
        .from(driverBookingLinks)
        .where(
          and(
            eq(driverBookingLinks.bookingId, booking.id),
            eq(driverBookingLinks.driverId, access.driverId),
            isNull(driverBookingLinks.revokedAt),
          ),
        )
        .orderBy(desc(driverBookingLinks.expiresAt))
        .limit(1);
      expiry = extension?.expiresAt ?? null;
    }
    const deadline = this.reportingDeadline(booking, expiry);
    if (this.now() > deadline)
      timelineError(
        'DRIVER_REPORTING_WINDOW_CLOSED',
        'Reporting window closed; ask an administrator to extend access',
        403,
      );
    return deadline;
  }

  async context(actor: TimelineActor, requestedBookingId?: string) {
    return this.db.transaction(async (tx) => {
      const initial = await this.resolveActor(tx, actor);
      const bookingId = initial.bookingId ?? requestedBookingId;
      if (!bookingId) timelineError('BOOKING_REQUIRED', 'Booking is required', 400);
      const booking = await this.lockBooking(tx, bookingId);
      const access = await this.resolveActor(tx, actor);
      if (!['ACTIVE', 'COMPLETED'].includes(booking.status))
        timelineError('BOOKING_NOT_AVAILABLE', 'Booking is unavailable', 403);
      const rows = await tx
        .select({
          id: trips.id,
          assignmentVersion: trips.assignmentVersion,
          pickupLocation: trips.pickupLocation,
          destination: trips.destination,
          scheduledAt: trips.scheduledAt,
          scheduledEndAt: trips.scheduledEndAt,
          vehicle: trips.vehicleSnapshot,
          operationalStatus: timelineProgress.status,
          startedAt: timelineProgress.startedAt,
          completedAt: timelineProgress.completedAt,
        })
        .from(trips)
        .leftJoin(timelineProgress, eq(timelineProgress.tripId, trips.id))
        .where(
          and(
            eq(trips.bookingId, bookingId),
            eq(trips.driverId, access.driverId),
            ne(trips.status, 'ARCHIVED'),
          ),
        )
        .orderBy(asc(trips.scheduledAt));
      const grants = access.linkId
        ? await tx.select().from(driverLinkTrips).where(eq(driverLinkTrips.linkId, access.linkId))
        : null;
      const authorised = rows.filter(
        (t) =>
          !grants ||
          grants.some((g) => g.tripId === t.id && g.assignmentVersion === t.assignmentVersion),
      );
      if (!authorised.length)
        timelineError(
          'DRIVER_BOOKING_NOT_ASSIGNED',
          'No authorised trips remain in this booking',
          403,
        );
      const reportingClosesAt = await this.checkReportingWindow(tx, booking, access);
      return {
        booking: {
          id: booking.id,
          bookingReference: booking.bookingReference,
          passengerName: booking.passengerName,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          status: booking.status,
        },
        driverId: access.driverId,
        accessMethod: access.linkId ? 'LINK' : 'LOGIN',
        expiresAt: access.expiresAt,
        reportingClosesAt,
        trips: authorised.map((t) => ({
          ...t,
          operationalStatus: t.operationalStatus ?? 'UNKNOWN',
        })),
      };
    });
  }

  async driverBookings(driverId: string, accountId: string, page: number, pageSize: number) {
    return this.db.transaction(async (tx) => {
      await this.activeDriver(tx, driverId, accountId);
      const condition = and(
        eq(trips.driverId, driverId),
        ne(trips.status, 'ARCHIVED'),
        inArray(bookings.status, ['ACTIVE', 'COMPLETED']),
      );
      const rows = await tx
        .selectDistinct({
          id: bookings.id,
          bookingReference: bookings.bookingReference,
          startsAt: bookings.startsAt,
          endsAt: bookings.endsAt,
          status: bookings.status,
        })
        .from(bookings)
        .innerJoin(trips, eq(trips.bookingId, bookings.id))
        .where(condition)
        .orderBy(desc(bookings.startsAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [total] = await tx
        .select({ count: sql<number>`count(distinct ${bookings.id})::int` })
        .from(bookings)
        .innerJoin(trips, eq(trips.bookingId, bookings.id))
        .where(condition);
      return { data: rows, pagination: { page, pageSize, total: total!.count } };
    });
  }

  async submit(actor: TimelineActor, input: CreateEventInput) {
    // Canonical field order makes payload matching independent of incoming JSON key order.
    const payloadHash = hash(
      JSON.stringify({
        tripId: input.tripId,
        assignmentVersion: input.assignmentVersion,
        type: input.type,
        occurredAt: new Date(input.occurredAt).toISOString(),
        recordedAt: new Date(input.recordedAt).toISOString(),
        submissionMode: input.submissionMode,
        note: input.note?.trim() || null,
        location: input.location
          ? {
              latitude: input.location.latitude,
              longitude: input.location.longitude,
              accuracyMeters: input.location.accuracyMeters,
              capturedAt: new Date(input.location.capturedAt).toISOString(),
            }
          : null,
        photoIds: [...(input.photoIds ?? [])].sort(),
        correctsEventId: input.correctsEventId ?? null,
        correctionReason: input.correctionReason?.trim() || null,
      }),
    );
    return this.db.transaction(async (tx) => {
      const { trip, booking, access } = await this.authorisedTrip(
        tx,
        actor,
        input.tripId,
        input.assignmentVersion,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${'timeline-client:' + input.clientEventId}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(timelineEvents)
        .where(eq(timelineEvents.clientEventId, input.clientEventId));
      if (existing) {
        if (existing.driverId !== access.driverId || existing.payloadHash !== payloadHash)
          timelineError(
            'TIMELINE_RETRY_CONFLICT',
            'This event ID has already been used for different data',
          );
        return { id: existing.id, receivedAt: existing.receivedAt, replayed: true };
      }
      await this.checkReportingWindow(tx, booking, access);
      const now = this.now(),
        occurredAt = new Date(input.occurredAt),
        recordedAt = new Date(input.recordedAt);
      validateEventTimes(occurredAt, recordedAt, now, booking.startsAt);
      if (
        input.location &&
        (new Date(input.location.capturedAt).getTime() > recordedAt.getTime() + 300_000 ||
          !Number.isFinite(new Date(input.location.capturedAt).getTime()))
      )
        timelineError(
          'TIMELINE_LOCATION_TIME_INVALID',
          'Location capture time cannot be later than event recording',
          400,
        );
      if (input.type === 'CORRECTION') {
        if (!input.correctsEventId || !input.correctionReason?.trim())
          timelineError(
            'TIMELINE_CORRECTION_INVALID',
            'A correction requires an original event and reason',
            400,
          );
        const [original] = await tx
          .select()
          .from(timelineEvents)
          .where(eq(timelineEvents.id, input.correctsEventId));
        if (
          !original ||
          original.tripId !== trip.id ||
          original.driverId !== access.driverId ||
          original.assignmentVersion !== trip.assignmentVersion ||
          original.type === 'CORRECTION'
        )
          timelineError(
            'TIMELINE_CORRECTION_INVALID',
            'Only your original events for the current assignment can be corrected',
            403,
          );
        if (!input.note?.trim() && !input.location)
          timelineError('TIMELINE_CORRECTION_INVALID', 'Supply a corrected note or location', 400);
      } else if (input.correctsEventId || input.correctionReason)
        timelineError(
          'TIMELINE_CORRECTION_INVALID',
          'Correction fields require a correction event',
          400,
        );
      if (
        (input.type === 'NOTE' || input.type === 'DELAY') &&
        !input.note?.trim() &&
        !input.photoIds?.length
      )
        timelineError('TIMELINE_EVENT_EMPTY', 'Add a note or photo', 400);
      await tx.insert(timelineProgress).values({ tripId: trip.id }).onConflictDoNothing();
      const [progress] = await tx
        .select()
        .from(timelineProgress)
        .where(eq(timelineProgress.tripId, trip.id));
      const status = nextProgress(
        progress!.status,
        input.type,
        occurredAt,
        progress!.startedAt,
        progress!.completedAt,
      );
      const id = randomUUID();
      if (input.photoIds?.length) {
        const photos = await tx
          .select()
          .from(timelinePhotos)
          .where(inArray(timelinePhotos.id, input.photoIds))
          .for('update');
        if (
          photos.length !== input.photoIds.length ||
          photos.some(
            (p) =>
              p.tripId !== trip.id ||
              p.driverId !== access.driverId ||
              p.assignmentVersion !== trip.assignmentVersion ||
              p.status !== 'READY',
          )
        )
          timelineError(
            'TIMELINE_PHOTO_INVALID',
            'Photos must be verified, unattached, and belong to this assignment',
            400,
          );
      }
      await tx.insert(timelineEvents).values({
        id,
        clientEventId: input.clientEventId,
        payloadHash,
        bookingId: booking.id,
        tripId: trip.id,
        driverId: access.driverId,
        driverNameSnapshot: trip.driverNameSnapshot,
        assignmentVersion: trip.assignmentVersion,
        actorAccountId: access.accountId,
        linkId: access.linkId,
        type: input.type,
        note: input.note?.trim() || null,
        location: input.location ?? null,
        occurredAt,
        recordedAt,
        receivedAt: now,
        submissionMode: input.submissionMode,
        correctsEventId: input.correctsEventId ?? null,
        correctionReason: input.correctionReason?.trim() || null,
      });
      if (input.photoIds?.length)
        await tx
          .update(timelinePhotos)
          .set({ eventId: id, status: 'ATTACHED' })
          .where(inArray(timelinePhotos.id, input.photoIds));
      const starts = input.type === 'TRIP_STARTED' || input.type === 'PASSENGER_PICKED_UP';
      await tx
        .update(timelineProgress)
        .set({
          status,
          startedAt:
            starts && (!progress!.startedAt || occurredAt < progress!.startedAt)
              ? occurredAt
              : progress!.startedAt,
          completedAt: input.type === 'TRIP_COMPLETED' ? occurredAt : progress!.completedAt,
          updatedAt: now,
        })
        .where(eq(timelineProgress.tripId, trip.id));
      await tx.insert(auditEvents).values({
        actorAccountId: access.accountId,
        action: 'TIMELINE_EVENT_RECORDED',
        entityType: 'TRIP',
        entityId: trip.id,
        metadata: {
          eventId: id,
          driverId: access.driverId,
          accessMethod: access.linkId ? 'LINK' : 'LOGIN',
          linkId: access.linkId,
          type: input.type,
        },
      });
      return { id, receivedAt: now, replayed: false };
    });
  }

  async timeline(
    bookingId: string,
    page: number,
    pageSize: number,
    actor?: TimelineActor,
    tripId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await this.lockBooking(tx, bookingId);
      let driverId: string | undefined;
      let authorisedIds: string[] | undefined;
      if (actor) {
        const context = await this.resolveActor(tx, actor);
        if (context.bookingId && context.bookingId !== bookingId)
          timelineError('TRIP_ACCESS_DENIED', 'Link belongs to a different booking', 403);
        driverId = context.driverId;
        const booking = await this.lockBooking(tx, bookingId);
        if (!['ACTIVE', 'COMPLETED'].includes(booking.status))
          timelineError('BOOKING_NOT_AVAILABLE', 'Booking is unavailable', 403);
        await this.checkReportingWindow(tx, booking, context);
        const assigned = await tx
          .select({ id: trips.id, version: trips.assignmentVersion })
          .from(trips)
          .where(
            and(
              eq(trips.bookingId, bookingId),
              eq(trips.driverId, driverId),
              ne(trips.status, 'ARCHIVED'),
            ),
          );
        const grants = context.linkId
          ? await tx
              .select()
              .from(driverLinkTrips)
              .where(eq(driverLinkTrips.linkId, context.linkId))
          : null;
        authorisedIds = assigned
          .filter(
            (t) =>
              !grants || grants.some((g) => g.tripId === t.id && g.assignmentVersion === t.version),
          )
          .map((t) => t.id);
        if (!authorisedIds.length)
          timelineError('DRIVER_BOOKING_NOT_ASSIGNED', 'No authorised trips remain', 403);
      }
      // Drivers see only their own updates; admins see the combined booking history.
      const condition = and(
        eq(timelineEvents.bookingId, bookingId),
        authorisedIds ? inArray(timelineEvents.tripId, authorisedIds) : undefined,
        driverId ? eq(timelineEvents.driverId, driverId) : undefined,
        tripId ? eq(timelineEvents.tripId, tripId) : undefined,
      );
      const rows = await tx
        .select()
        .from(timelineEvents)
        .where(condition)
        .orderBy(
          asc(timelineEvents.occurredAt),
          asc(timelineEvents.receivedAt),
          asc(timelineEvents.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [total] = await tx.select({ count: count() }).from(timelineEvents).where(condition);
      const photos = rows.length
        ? await tx
            .select({ id: timelinePhotos.id, eventId: timelinePhotos.eventId })
            .from(timelinePhotos)
            .where(
              inArray(
                timelinePhotos.eventId,
                rows.map((e) => e.id),
              ),
            )
        : [];
      return {
        data: rows.map((row) => {
          const e = { ...row };
          Reflect.deleteProperty(e, 'payloadHash');
          return {
            ...e,
            accessMethod: e.linkId ? 'LINK' : 'LOGIN',
            backdated: e.occurredAt.getTime() < e.recordedAt.getTime() - 60_000,
            photos: photos.filter((p) => p.eventId === e.id).map((p) => ({ id: p.id })),
          };
        }),
        pagination: { page, pageSize, total: total!.count },
      };
    });
  }

  async overview(page: number, pageSize: number, bookingId?: string) {
    const condition = and(
      ne(trips.status, 'ARCHIVED'),
      bookingId ? eq(trips.bookingId, bookingId) : undefined,
    );
    const data = await this.db
      .select({
        tripId: trips.id,
        bookingId: bookings.id,
        bookingReference: bookings.bookingReference,
        bookingStatus: bookings.status,
        driverId: trips.driverId,
        driverName: trips.driverNameSnapshot,
        assignmentVersion: trips.assignmentVersion,
        scheduledAt: trips.scheduledAt,
        scheduledEndAt: trips.scheduledEndAt,
        pickupLocation: trips.pickupLocation,
        destination: trips.destination,
        operationalStatus: sql<OperationalStatus>`coalesce(${timelineProgress.status},'UNKNOWN')`,
        startedAt: timelineProgress.startedAt,
        completedAt: timelineProgress.completedAt,
        latestUpdate: sql<Record<
          string,
          unknown
        > | null>`(select json_build_object('id',e.id,'type',e.type,'occurredAt',e.occurred_at,'receivedAt',e.received_at,'driverName',e.driver_name_snapshot) from feedback_timeline_events e where e.trip_id = ${trips.id} order by e.received_at desc,e.id desc limit 1)`,
        readyToClose: sql<boolean>`exists(select 1 from trips t where t.booking_id = ${bookings.id} and t.status <> 'ARCHIVED') and not exists(select 1 from trips t left join feedback_trip_progress p on p.trip_id = t.id where t.booking_id = ${bookings.id} and t.status <> 'ARCHIVED' and coalesce(p.status,'UNKNOWN') not in ('COMPLETED','CANCELLED'))`,
      })
      .from(trips)
      .innerJoin(bookings, eq(bookings.id, trips.bookingId))
      .leftJoin(timelineProgress, eq(timelineProgress.tripId, trips.id))
      .where(condition)
      .orderBy(desc(trips.scheduledAt), asc(trips.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const [total] = await this.db.select({ count: count() }).from(trips).where(condition);
    return { data, pagination: { page, pageSize, total: total!.count } };
  }

  async setProgress(tripId: string, status: OperationalStatus, reason: string, accountId: string) {
    return this.db.transaction(async (tx) => {
      const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId));
      if (!trip) timelineError('TRIP_NOT_FOUND', 'Trip was not found', 404);
      const booking = await this.lockBooking(tx, trip.bookingId);
      if (booking.status !== 'ACTIVE' || trip.status === 'ARCHIVED')
        timelineError('BOOKING_NOT_AVAILABLE', 'Reopen the booking before changing trip progress');
      const [freshTrip] = await tx.select().from(trips).where(eq(trips.id, tripId)).for('update');
      if (!freshTrip || freshTrip.bookingId !== trip.bookingId || freshTrip.status === 'ARCHIVED')
        timelineError('TRIP_ASSIGNMENT_CHANGED', 'Trip changed; reload before changing progress');
      const [current] = await tx
        .select()
        .from(timelineProgress)
        .where(eq(timelineProgress.tripId, tripId));
      const now = this.now();
      await tx
        .insert(timelineProgress)
        .values({
          tripId,
          status,
          completedAt: status === 'COMPLETED' ? now : null,
          startedAt: status === 'IN_PROGRESS' ? now : null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: timelineProgress.tripId,
          set: {
            status,
            completedAt: status === 'COMPLETED' ? now : null,
            startedAt: status === 'IN_PROGRESS' ? now : null,
            updatedAt: now,
          },
        });
      // New operational cycle rejects queued events and link grants from the previous cycle.
      await tx
        .update(trips)
        .set({ assignmentVersion: sql`${trips.assignmentVersion}+1`, updatedAt: now })
        .where(eq(trips.id, tripId));
      await tx.insert(auditEvents).values({
        actorAccountId: accountId,
        action: 'TRIP_OPERATION_CHANGED',
        entityType: 'TRIP',
        entityId: tripId,
        metadata: { from: current?.status ?? 'UNKNOWN', to: status, reason: reason.trim() },
      });
      return { tripId, status };
    });
  }

  async createPhoto(
    actor: TimelineActor,
    input: {
      tripId: string;
      assignmentVersion: number;
      contentType: AcceptedPhotoContentType;
      sizeBytes: number;
    },
  ) {
    if (!this.storage.enabled)
      timelineError('PHOTO_STORAGE_UNAVAILABLE', 'Photo storage is not configured', 503);
    if (input.sizeBytes <= 0 || input.sizeBytes > this.storage.maxUploadBytes)
      timelineError('TIMELINE_PHOTO_SIZE_INVALID', 'Photo exceeds the upload limit', 400);
    return this.db.transaction(async (tx) => {
      const { trip, booking, access } = await this.authorisedTrip(
        tx,
        actor,
        input.tripId,
        input.assignmentVersion,
      );
      await this.checkReportingWindow(tx, booking, access);
      const id = randomUUID(),
        expiresAt = new Date(this.now().getTime() + this.storage.uploadUrlTtlSeconds * 1000);
      const namespace = `timeline/${trip.id}`;
      const uploadObjectKey = this.storage.buildUploadObjectKey(namespace, id),
        objectKey = this.storage.buildStoredObjectKey(namespace, id);
      await tx.insert(timelinePhotos).values({
        id,
        tripId: trip.id,
        driverId: access.driverId,
        assignmentVersion: trip.assignmentVersion,
        contentType: input.contentType,
        uploadObjectKey,
        objectKey,
        uploadExpiresAt: expiresAt,
      });
      return {
        id,
        uploadUrl: await this.storage.createUploadUrl(uploadObjectKey, input.contentType),
        method: 'PUT',
        headers: { 'Content-Type': input.contentType },
        expiresAt,
        maxBytes: this.storage.maxUploadBytes,
      };
    });
  }

  async completePhoto(actor: TimelineActor, id: string) {
    if (!this.storage.enabled)
      timelineError('PHOTO_STORAGE_UNAVAILABLE', 'Photo storage is not configured', 503);
    return this.db.transaction(async (tx) => {
      const [initial] = await tx.select().from(timelinePhotos).where(eq(timelinePhotos.id, id));
      if (!initial) timelineError('TIMELINE_PHOTO_NOT_FOUND', 'Photo was not found', 404);
      const { booking, access } = await this.authorisedTrip(
        tx,
        actor,
        initial.tripId,
        initial.assignmentVersion,
      );
      if (initial.driverId !== access.driverId)
        timelineError('TRIP_ACCESS_DENIED', 'Photo belongs to another driver', 403);
      await this.checkReportingWindow(tx, booking, access);
      const [photo] = await tx
        .select()
        .from(timelinePhotos)
        .where(eq(timelinePhotos.id, id))
        .for('update');
      if (!photo) timelineError('TIMELINE_PHOTO_NOT_FOUND', 'Photo was not found', 404);
      if (photo.status === 'READY' || photo.status === 'ATTACHED')
        return { id: photo.id, status: photo.status, completedAt: photo.completedAt };
      if (photo.status !== 'PENDING' || photo.uploadExpiresAt <= this.now())
        timelineError('TIMELINE_PHOTO_EXPIRED', 'Photo upload expired; create another upload');
      try {
        const stored = await this.storage.sanitize(
          photo.uploadObjectKey,
          photo.objectKey,
          photo.contentType,
        );
        const completedAt = this.now();
        await tx
          .update(timelinePhotos)
          .set({ status: 'READY', byteSize: stored.byteSize, completedAt })
          .where(eq(timelinePhotos.id, id));
        return { id, status: 'READY', completedAt };
      } catch (error) {
        if (error instanceof InvalidStoredPhotoError)
          timelineError('TIMELINE_PHOTO_INVALID', error.message, 400);
        throw error;
      }
    });
  }

  async photoUrl(id: string, actor?: TimelineActor) {
    if (!this.storage.enabled)
      timelineError('PHOTO_STORAGE_UNAVAILABLE', 'Photo storage is not configured', 503);
    return this.db.transaction(async (tx) => {
      const [photo] = await tx
        .select()
        .from(timelinePhotos)
        .where(and(eq(timelinePhotos.id, id), eq(timelinePhotos.status, 'ATTACHED')));
      if (!photo) timelineError('TIMELINE_PHOTO_NOT_FOUND', 'Photo was not found', 404);
      if (actor) {
        const { access, booking } = await this.authorisedTrip(
          tx,
          actor,
          photo.tripId,
          photo.assignmentVersion,
        );
        if (photo.driverId !== access.driverId)
          timelineError('TRIP_ACCESS_DENIED', 'Photo belongs to another driver', 403);
        await this.checkReportingWindow(tx, booking, access);
      }
      return {
        id,
        url: await this.storage.createDownloadUrl(photo.objectKey),
        expiresAt: new Date(this.now().getTime() + this.storage.downloadUrlTtlSeconds * 1000),
      };
    });
  }

  async cleanupPhotos() {
    if (!this.storage.enabled) return 0;
    const cutoff = new Date(this.now().getTime() - hours(this.storage.orphanTtlHours));
    // Presigned PUT URLs can still be reused until expiry after an image was sanitised.
    // Sweep temporary objects even for attached photos; never delete their stored JPEGs.
    const expired = await this.db
      .select({ id: timelinePhotos.id })
      .from(timelinePhotos)
      .where(
        and(
          isNull(timelinePhotos.temporaryObjectCleanedAt),
          lt(timelinePhotos.uploadExpiresAt, this.now()),
        ),
      );
    for (const candidate of expired)
      await this.db.transaction(async (tx) => {
        const [photo] = await tx
          .select()
          .from(timelinePhotos)
          .where(
            and(
              eq(timelinePhotos.id, candidate.id),
              isNull(timelinePhotos.temporaryObjectCleanedAt),
            ),
          )
          .for('update');
        if (!photo) return;
        await this.storage.delete(photo.uploadObjectKey);
        await tx
          .update(timelinePhotos)
          .set({ temporaryObjectCleanedAt: this.now() })
          .where(eq(timelinePhotos.id, photo.id));
      });
    const candidates = await this.db
      .select({ id: timelinePhotos.id })
      .from(timelinePhotos)
      .where(and(isNull(timelinePhotos.eventId), lt(timelinePhotos.createdAt, cutoff)));
    let removed = 0;
    for (const candidate of candidates)
      await this.db.transaction(async (tx) => {
        const [photo] = await tx
          .select()
          .from(timelinePhotos)
          .where(and(eq(timelinePhotos.id, candidate.id), isNull(timelinePhotos.eventId)))
          .for('update');
        if (!photo) return;
        await this.storage.delete(photo.uploadObjectKey);
        await this.storage.delete(photo.objectKey);
        await tx.delete(timelinePhotos).where(eq(timelinePhotos.id, photo.id));
        removed++;
      });
    return removed;
  }
}
