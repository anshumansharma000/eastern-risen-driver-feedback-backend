import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices, type ApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import {
  authAccounts,
  auditEvents,
  bookings,
  drivers,
  trips,
  vehicles,
  bookingDriverEngagements,
  driverBookingLinks,
  driverLinkTrips,
  timelineEvents,
  timelinePhotos,
  timelineProgress,
  engagementFeedbackSections,
} from '../src/database/schema/index.js';
import {
  TimelineService,
  type CreateEventInput,
} from '../src/modules/timeline/timeline.service.js';
import { passwordHasher } from '../src/modules/auth/password.js';
import { createFieldEncryptor } from '../src/shared/security/field-encryption.js';
import type { PhotoStorage } from '../src/shared/storage/photo-storage.js';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

integration('feedback-product driver timeline and booking links', () => {
  let database: DatabaseClient, app: FastifyInstance, services: ApplicationServices;
  let adminId: string,
    driverId: string,
    driverAccount: string,
    otherId: string,
    otherAccount: string,
    vehicleId: string;
  let adminCookie: string,
    driverCookie: string,
    coreCookie: string,
    bookingId: string,
    tripId: string,
    otherTripId: string,
    token: string;
  const accountIds: string[] = [],
    bookingIds: string[] = [],
    tripIds: string[] = [];
  const suffix = randomUUID(),
    password = 'timeline-integration-password';
  const deletedKeys: string[] = [];
  let clock = new Date();
  let fixtureNumber = 0;
  const storage: PhotoStorage = {
    enabled: true,
    maxUploadBytes: 1000000,
    uploadUrlTtlSeconds: 600,
    downloadUrlTtlSeconds: 300,
    orphanTtlHours: 24,
    buildUploadObjectKey: (trip, id) => `timeline-test/pending/${trip}/${id}`,
    buildStoredObjectKey: (trip, id) => `timeline-test/stored/${trip}/${id}`,
    createUploadUrl: async (key) => `https://storage.example/upload/${key}`,
    sanitize: async () => ({ contentType: 'image/jpeg', byteSize: 100 }),
    createDownloadUrl: async (key) => `https://storage.example/download/${key}`,
    delete: async (key) => {
      deletedKeys.push(key);
    },
  };
  const cookieOf = (response: { headers: Record<string, unknown> }) => {
    const value = response.headers['set-cookie'];
    return (Array.isArray(value) ? String(value[0]) : String(value)).split(';')[0]!;
  };
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      DRIVER_BOOKING_URL: 'https://drivers.example/booking',
    });
    database = createDatabaseClient(config);
    const hash = await passwordHasher.hash(password);
    for (const role of ['ADMIN', 'DRIVER', 'DRIVER', 'CORE_ADMIN'] as const) {
      const [account] = await database.db
        .insert(authAccounts)
        .values({
          role,
          displayName: `Timeline ${role}`,
          email: `${accountIds.length}-${suffix}@example.com`,
          passwordHash: hash,
        })
        .returning();
      accountIds.push(account!.id);
    }
    [adminId, driverAccount, otherAccount] = accountIds as [string, string, string, string];
    const ds = await database.db
      .insert(drivers)
      .values([
        { accountId: driverAccount, driverCode: `TL-${suffix}`, sourceType: 'AGENCY' },
        { accountId: otherAccount, driverCode: `TO-${suffix}`, sourceType: 'AGENCY' },
      ])
      .returning();
    driverId = ds[0]!.id;
    otherId = ds[1]!.id;
    const [vehicle] = await database.db
      .insert(vehicles)
      .values({
        registrationNumber: `TL-${suffix}`,
        displayName: 'Timeline vehicle',
        vehicleType: 'CAR',
      })
      .returning();
    vehicleId = vehicle!.id;
    services = createApplicationServices(database.db, config);
    services = {
      ...services,
      timelineService: new TimelineService(
        database.db,
        createFieldEncryptor(config.dataEncryptionKey),
        storage,
        config.driverBookingUrl,
        () => clock,
      ),
    };
    app = await buildApp({ exposeDocs: false, services });
    adminCookie = cookieOf(
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/admin/login',
        payload: { email: `0-${suffix}@example.com`, password },
      }),
    );
    driverCookie = cookieOf(
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/driver/login',
        payload: { driverCode: `TL-${suffix}`, password },
      }),
    );
    coreCookie = `${services.cookieName}=${(await services.authService.loginCore(`3-${suffix}@example.com`, password)).token}`;
  });
  beforeEach(async () => {
    clock = new Date();
    fixtureNumber++;
    const [booking] = await database.db
      .insert(bookings)
      .values({
        bookingReference: `TIMELINE-${suffix}-${fixtureNumber}`,
        passengerName: 'Timeline passenger',
        startsAt: new Date(clock.getTime() - 7200000),
        endsAt: new Date(clock.getTime() + 86400000 * 60),
        createdByAccountId: adminId,
      })
      .returning();
    bookingId = booking!.id;
    bookingIds.push(bookingId);
    const schedule = new Date(clock.getTime() + 86400000 * fixtureNumber);
    const t = await services.tripService.createAdmin(
      {
        bookingId,
        driverId,
        vehicleId,
        pickupLocation: 'Airport',
        destination: 'Hotel',
        scheduledAt: schedule.toISOString(),
        scheduledEndAt: new Date(schedule.getTime() + 3600000).toISOString(),
      },
      adminId,
    );
    tripId = t.id;
    tripIds.push(tripId);
    const other = await services.tripService.createAdmin(
      {
        bookingId,
        driverId: otherId,
        vehicleId,
        pickupLocation: 'Hotel',
        destination: 'Station',
        scheduledAt: new Date(schedule.getTime() + 7200000).toISOString(),
        scheduledEndAt: new Date(schedule.getTime() + 10800000).toISOString(),
      },
      adminId,
    );
    otherTripId = other.id;
    tripIds.push(otherTripId);
    const link = await services.timelineService.issueLink(bookingId, driverId, adminId, {});
    token = new URLSearchParams(new URL(link.link).hash.slice(1)).get('token')!;
  });
  afterAll(async () => {
    await app?.close();
    if (!database) return;
    if (bookingIds.length) {
      await database.db.delete(timelinePhotos).where(inArray(timelinePhotos.tripId, tripIds));
      await database.db.delete(timelineEvents).where(inArray(timelineEvents.bookingId, bookingIds));
      const links = await database.db
        .select({ id: driverBookingLinks.id })
        .from(driverBookingLinks)
        .where(inArray(driverBookingLinks.bookingId, bookingIds));
      if (links.length)
        await database.db.delete(driverLinkTrips).where(
          inArray(
            driverLinkTrips.linkId,
            links.map((l) => l.id),
          ),
        );
      await database.db
        .delete(driverBookingLinks)
        .where(inArray(driverBookingLinks.bookingId, bookingIds));
      await database.db.delete(trips).where(inArray(trips.bookingId, bookingIds));
      await database.db
        .delete(engagementFeedbackSections)
        .where(inArray(engagementFeedbackSections.bookingId, bookingIds));
      await database.db
        .delete(bookingDriverEngagements)
        .where(inArray(bookingDriverEngagements.bookingId, bookingIds));
      await database.db.delete(bookings).where(inArray(bookings.id, bookingIds));
    }
    await database.db.delete(auditEvents).where(inArray(auditEvents.actorAccountId, accountIds));
    if (tripIds.length)
      await database.db.delete(auditEvents).where(inArray(auditEvents.entityId, tripIds));
    await database.db.delete(drivers).where(inArray(drivers.accountId, accountIds));
    await database.db.delete(authAccounts).where(inArray(authAccounts.id, accountIds));
    if (vehicleId) await database.db.delete(vehicles).where(eq(vehicles.id, vehicleId));
    await database.close();
  });
  const event = (changes: Partial<CreateEventInput> = {}): CreateEventInput => ({
    clientEventId: randomUUID(),
    tripId,
    assignmentVersion: 1,
    type: 'TRIP_STARTED',
    occurredAt: new Date(clock.getTime() - 60000).toISOString(),
    recordedAt: clock.toISOString(),
    submissionMode: 'ONLINE',
    ...changes,
  });
  const post = (payload: CreateEventInput, headers = { authorization: `Bearer ${token}` }) =>
    app.inject({ method: 'POST', url: '/api/v1/driver-link/timeline/events', headers, payload });
  it('supports link and login with the same assignment context, without passenger contact or core access', async () => {
    const linked = await app.inject({
      url: '/api/v1/driver-link/timeline/context',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.headers['cache-control']).toBe('no-store');
    const context = linked.json<{
      data: { trips: { id: string; assignmentVersion: number; operationalStatus: string }[] };
    }>().data;
    expect(context.trips).toEqual([
      expect.objectContaining({ id: tripId, assignmentVersion: 1, operationalStatus: 'SCHEDULED' }),
    ]);
    expect(linked.body).not.toContain('passengerPhone');
    expect(linked.body).not.toContain('Ciphertext');
    expect(
      (
        await app.inject({
          url: `/api/v1/driver/timeline/bookings/${bookingId}/context`,
          headers: { cookie: driverCookie },
        })
      ).statusCode,
    ).toBe(200);
    expect((await post(event({ tripId: otherTripId }))).statusCode).toBe(403);
    expect(
      (await app.inject({ url: '/api/v1/admin/timeline/trips', headers: { cookie: coreCookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/v1/admin/timeline/trips',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: '/api/v1/driver-link/timeline/context' })).statusCode).toBe(
      401,
    );
  });
  const createAdditionalTrip = async (
    source: 'ADMIN' | 'DRIVER' = 'ADMIN',
    assignedDriverId = driverId,
    assignedBookingId = bookingId,
  ) => {
    const original = await services.tripService.get(tripId);
    const response = await app.inject({
      method: 'POST',
      url: source === 'ADMIN' ? '/api/v1/admin/trips' : '/api/v1/driver/trips',
      headers: { cookie: source === 'ADMIN' ? adminCookie : driverCookie },
      payload: {
        bookingId: assignedBookingId,
        ...(source === 'ADMIN' ? { driverId: assignedDriverId } : {}),
        vehicleId,
        pickupLocation: 'Station',
        destination: 'Airport',
        scheduledAt: new Date(original.scheduledAt.getTime() + 14400000).toISOString(),
        scheduledEndAt: new Date(original.scheduledAt.getTime() + 18000000).toISOString(),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<{ data: { id: string; assignmentVersion: number } }>().data;
    tripIds.push(created.id);
    return created;
  };
  it.each(['ADMIN', 'DRIVER'] as const)(
    'grants a new %s-created trip through the unchanged link and LOGIN APIs without refresh',
    async (source) => {
      const [before] = await database.db
        .select()
        .from(driverBookingLinks)
        .where(
          and(
            eq(driverBookingLinks.bookingId, bookingId),
            eq(driverBookingLinks.driverId, driverId),
          ),
        );
      const created = await createAdditionalTrip(source);
      for (const access of [
        { prefix: '/api/v1/driver-link/timeline', headers: { authorization: `Bearer ${token}` } },
        { prefix: '/api/v1/driver/timeline', headers: { cookie: driverCookie } },
      ]) {
        const context = await app.inject({
          url: access.prefix.endsWith('driver-link/timeline')
            ? `${access.prefix}/context`
            : `${access.prefix}/bookings/${bookingId}/context`,
          headers: access.headers,
        });
        expect(context.statusCode).toBe(200);
        expect(
          context.json<{ data: { trips: { id: string; assignmentVersion: number }[] } }>().data
            .trips,
        ).toEqual([
          expect.objectContaining({ id: tripId }),
          expect.objectContaining({ id: created.id, assignmentVersion: 1 }),
        ]);
        expect(context.json<{ data: { accessMethod: string } }>().data.accessMethod).toBe(
          access.prefix.endsWith('driver-link/timeline') ? 'LINK' : 'LOGIN',
        );
        const upload = await app.inject({
          method: 'POST',
          url: `${access.prefix}/photo-uploads`,
          headers: access.headers,
          payload: {
            tripId: created.id,
            assignmentVersion: 1,
            contentType: 'image/jpeg',
            sizeBytes: 100,
          },
        });
        expect(upload.statusCode, upload.body).toBe(201);
        const photoId = upload.json<{ data: { id: string } }>().data.id;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${access.prefix}/photo-uploads/${photoId}/complete`,
              headers: access.headers,
            })
          ).statusCode,
        ).toBe(200);
        const update = await app.inject({
          method: 'POST',
          url: `${access.prefix}/events`,
          headers: access.headers,
          payload: event({
            tripId: created.id,
            type: 'NOTE',
            note: 'New assignment',
            photoIds: [photoId],
          }),
        });
        expect(update.statusCode, update.body).toBe(201);
        const history = await app.inject({
          url: `${access.prefix}/bookings/${bookingId}/events?tripId=${created.id}`,
          headers: access.headers,
        });
        expect(history.statusCode).toBe(200);
        expect(history.json<{ data: { tripId: string }[] }>().data).toContainEqual(
          expect.objectContaining({ tripId: created.id }),
        );
      }
      const list = await app.inject({
        url: '/api/v1/driver/trips?pageSize=100',
        headers: { cookie: driverCookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json<{ data: { id: string }[] }>().data).toContainEqual(
        expect.objectContaining({ id: created.id }),
      );
      const bookingList = await app.inject({
        url: '/api/v1/driver/timeline/bookings',
        headers: { cookie: driverCookie },
      });
      expect(bookingList.statusCode).toBe(200);
      expect(bookingList.json<{ data: { id: string }[] }>().data).toContainEqual(
        expect.objectContaining({ id: bookingId }),
      );
      const [after] = await database.db
        .select()
        .from(driverBookingLinks)
        .where(eq(driverBookingLinks.id, before!.id));
      expect(after).toEqual(before);
      const issued = await database.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.entityId, bookingId),
            eq(auditEvents.action, 'DRIVER_BOOKING_LINK_ISSUED'),
          ),
        );
      expect(issued).toHaveLength(1);
      const otherLink = await services.timelineService.issueLink(bookingId, otherId, adminId, {});
      const otherToken = new URLSearchParams(new URL(otherLink.link).hash.slice(1)).get('token')!;
      expect(
        (await post(event({ tripId: created.id }), { authorization: `Bearer ${otherToken}` }))
          .statusCode,
      ).toBe(403);
      await expect(
        services.timelineService.createPhoto(
          { token: otherToken },
          {
            tripId: created.id,
            assignmentVersion: 1,
            contentType: 'image/jpeg',
            sizeBytes: 100,
          },
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      await expect(
        services.timelineService.submit(
          { driverId: otherId, accountId: otherAccount },
          event({ tripId: created.id }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect((await post(event({ tripId: created.id, assignmentVersion: 2 }))).statusCode).toBe(
        409,
      );
    },
  );
  it.each(['MISSING', 'EXPIRED', 'REVOKED'] as const)(
    'does not issue or revive a %s link when a new trip is created',
    async (state) => {
      const [link] = await database.db
        .select()
        .from(driverBookingLinks)
        .where(
          and(
            eq(driverBookingLinks.bookingId, bookingId),
            eq(driverBookingLinks.driverId, driverId),
          ),
        );
      if (state === 'MISSING') {
        await database.db.delete(driverLinkTrips).where(eq(driverLinkTrips.linkId, link!.id));
        await database.db.delete(driverBookingLinks).where(eq(driverBookingLinks.id, link!.id));
      } else {
        await database.db
          .update(driverBookingLinks)
          .set(
            state === 'EXPIRED'
              ? { expiresAt: new Date(Date.now() - 1000) }
              : { revokedAt: new Date() },
          )
          .where(eq(driverBookingLinks.id, link!.id));
      }
      const before = await database.db
        .select()
        .from(driverBookingLinks)
        .where(eq(driverBookingLinks.id, link!.id));
      const created = await createAdditionalTrip();
      expect(
        await database.db
          .select()
          .from(driverBookingLinks)
          .where(
            and(
              eq(driverBookingLinks.bookingId, bookingId),
              eq(driverBookingLinks.driverId, driverId),
            ),
          ),
      ).toEqual(before);
      expect(
        await database.db
          .select()
          .from(driverLinkTrips)
          .where(eq(driverLinkTrips.tripId, created.id)),
      ).toEqual([]);
      expect((await post(event({ tripId: created.id }))).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url: '/api/v1/driver-link/timeline/context',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/driver-link/timeline/photo-uploads',
            headers: { authorization: `Bearer ${token}` },
            payload: {
              tripId: created.id,
              assignmentVersion: 1,
              contentType: 'image/jpeg',
              sizeBytes: 100,
            },
          })
        ).statusCode,
      ).toBe(401);
    },
  );
  it('does not grant new trips belonging to another driver or booking', async () => {
    const anotherDriver = await createAdditionalTrip('ADMIN', otherId);
    expect(
      await database.db
        .select()
        .from(driverLinkTrips)
        .where(eq(driverLinkTrips.tripId, anotherDriver.id)),
    ).toEqual([]);
    expect((await post(event({ tripId: anotherDriver.id }))).statusCode).toBe(403);
    await expect(
      services.timelineService.createPhoto(
        { token },
        {
          tripId: anotherDriver.id,
          assignmentVersion: 1,
          contentType: 'image/jpeg',
          sizeBytes: 100,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const [booking] = await database.db
      .insert(bookings)
      .values({
        bookingReference: `OTHER-${suffix}-${fixtureNumber}`,
        passengerName: 'Other booking',
        startsAt: new Date(clock.getTime() - 7200000),
        endsAt: new Date(clock.getTime() + 86400000 * 60),
        createdByAccountId: adminId,
      })
      .returning();
    bookingIds.push(booking!.id);
    await services.tripService.archive(anotherDriver.id, adminId);
    const anotherBooking = await createAdditionalTrip('ADMIN', driverId, booking!.id);
    expect(
      await database.db
        .select()
        .from(driverLinkTrips)
        .where(eq(driverLinkTrips.tripId, anotherBooking.id)),
    ).toEqual([]);
    expect((await post(event({ tripId: anotherBooking.id }))).statusCode).toBe(403);
    await expect(
      services.timelineService.createPhoto(
        { token },
        {
          tripId: anotherBooking.id,
          assignmentVersion: 1,
          contentType: 'image/jpeg',
          sizeBytes: 100,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const context = await services.timelineService.context({ token });
    expect(context.trips.map((trip) => trip.id)).toEqual([tripId]);
  });
  it('records location and handles concurrent retries; rejects changed payloads', async () => {
    const input = event({
      location: {
        latitude: 28.6,
        longitude: 77.2,
        accuracyMeters: 10,
        capturedAt: clock.toISOString(),
      },
    });
    const replies = await Promise.all([post(input), post(input)]);
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect((await post({ ...input, note: 'Changed' })).statusCode).toBe(409);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/timeline/events',
      headers: { cookie: driverCookie },
      payload: input,
    });
    expect(login.statusCode).toBe(200);
    const rows = await database.db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.tripId, tripId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.location?.accuracyMeters).toBe(10);
    expect(rows[0]!.actorAccountId).toBeNull();
  });
  it('keeps completion independent of feedback, permits late milestones and audited corrections', async () => {
    await post(event());
    const completion = event({ type: 'TRIP_COMPLETED', occurredAt: clock.toISOString() });
    expect((await post(completion)).statusCode).toBe(201);
    expect(
      (await post(event({ type: 'ARRIVED', submissionMode: 'OFFLINE_SYNC' }))).statusCode,
    ).toBe(201);
    expect(
      (
        await database.db.select().from(timelineProgress).where(eq(timelineProgress.tripId, tripId))
      )[0]!.status,
    ).toBe('COMPLETED');
    expect((await database.db.select().from(trips).where(eq(trips.id, tripId)))[0]!.status).toBe(
      'READY',
    );
    const note = await post(event({ type: 'NOTE', note: 'Old note' }));
    const id = note.json<{ data: { id: string } }>().data.id;
    expect(
      (
        await post(
          event({
            type: 'CORRECTION',
            correctsEventId: id,
            correctionReason: 'Typo',
            note: 'Corrected note',
          }),
        )
      ).statusCode,
    ).toBe(201);
    const timeline = await app.inject({
      url: `/api/v1/admin/timeline/bookings/${bookingId}/events`,
      headers: { cookie: adminCookie },
    });
    expect(timeline.body).toContain('Old note');
    expect(timeline.body).toContain('Corrected note');
    expect(timeline.body).not.toContain('payloadHash');
    expect((await post(event({ type: 'TRIP_COMPLETED' }))).statusCode).toBe(409);
    const reopen = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/timeline/trips/${tripId}/progress`,
      headers: { cookie: adminCookie },
      payload: { status: 'SCHEDULED', reason: 'Trip reopened' },
    });
    expect(reopen.statusCode).toBe(200);
    expect((await post(event())).statusCode).toBe(409);
    await createAdditionalTrip();
    expect((await post(event({ assignmentVersion: 2 }))).statusCode).toBe(403);
    const fresh = await services.timelineService.issueLink(bookingId, driverId, adminId, {});
    token = new URLSearchParams(new URL(fresh.link).hash.slice(1)).get('token')!;
    expect((await post(event({ assignmentVersion: 2 }))).statusCode).toBe(201);
  });
  it('preserves timeline and link when schedule edits rebuild feedback engagements', async () => {
    expect((await post(event())).statusCode).toBe(201);
    const old = await database.db
      .select({ id: bookingDriverEngagements.id })
      .from(bookingDriverEngagements)
      .where(eq(bookingDriverEngagements.bookingId, bookingId));
    await services.tripService.update(tripId, { destination: 'New hotel' }, adminId);
    const fresh = await database.db
      .select({ id: bookingDriverEngagements.id })
      .from(bookingDriverEngagements)
      .where(eq(bookingDriverEngagements.bookingId, bookingId));
    expect(fresh[0]!.id).not.toBe(old[0]!.id);
    expect((await post(event({ type: 'NOTE', note: 'Still works' }))).statusCode).toBe(201);
    const otherBooking = bookingIds[0]!;
    if (otherBooking !== bookingId)
      await expect(
        services.tripService.update(tripId, { bookingId: otherBooking }, adminId),
      ).rejects.toMatchObject({ code: 'TRIP_TIMELINE_BOOKING_LOCKED' });
  });
  it('rejects stale assignments and does not revive old access when a driver returns', async () => {
    await post(event());
    await services.tripService.update(tripId, { driverId: otherId }, adminId);
    expect((await post(event())).statusCode).toBe(401);
    await services.tripService.update(tripId, { driverId }, adminId);
    expect((await post(event({ assignmentVersion: 3 }))).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/timeline/events',
      headers: { cookie: driverCookie },
      payload: event(),
    });
    expect(login.statusCode).toBe(409);
    const rows = await database.db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.tripId, tripId));
    expect(rows[0]!.driverId).toBe(driverId);
  });
  it('regenerates, revokes, expires and cancels driver links', async () => {
    const oldToken = token;
    const fresh = await services.timelineService.issueLink(bookingId, driverId, adminId, {
      regenerate: true,
      expiresAt: new Date(clock.getTime() + 3600000).toISOString(),
    });
    expect((await post(event(), { authorization: `Bearer ${oldToken}` })).statusCode).toBe(401);
    token = new URLSearchParams(new URL(fresh.link).hash.slice(1)).get('token')!;
    clock = new Date(clock.getTime() + 7200000);
    expect((await post(event())).statusCode).toBe(401);
    clock = new Date();
    const newLink = await services.timelineService.issueLink(bookingId, driverId, adminId, {});
    token = new URLSearchParams(new URL(newLink.link).hash.slice(1)).get('token')!;
    await services.bookingService.update(bookingId, { status: 'CANCELLED' }, adminId);
    expect((await post(event())).statusCode).toBe(401);
    await services.bookingService.update(bookingId, { status: 'ACTIVE' }, adminId);
    expect((await post(event())).statusCode).toBe(401);
    await services.timelineService.revokeLink(bookingId, driverId, adminId);
  });
  it('attaches verified photos only to their own assignment and cleans only orphans', async () => {
    const upload = await services.timelineService.createPhoto(
      { token },
      { tripId, assignmentVersion: 1, contentType: 'image/jpeg', sizeBytes: 100 },
    );
    expect((await post(event({ photoIds: [upload.id] }))).statusCode).toBe(400);
    await services.timelineService.completePhoto({ token }, upload.id);
    expect((await post(event({ photoIds: [upload.id] }))).statusCode).toBe(201);
    expect((await services.timelineService.photoUrl(upload.id)).url).toContain('download');
    await expect(
      services.timelineService.photoUrl(upload.id, { driverId: otherId, accountId: otherAccount }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const orphan = await services.timelineService.createPhoto(
      { token },
      { tripId, assignmentVersion: 1, contentType: 'image/png', sizeBytes: 100 },
    );
    await database.db
      .update(timelinePhotos)
      .set({ createdAt: new Date(clock.getTime() - 86400000 * 2) })
      .where(eq(timelinePhotos.id, orphan.id));
    expect(await services.timelineService.cleanupPhotos()).toBe(1);
    expect(deletedKeys).toContain(orphan.uploadUrl.replace('https://storage.example/upload/', ''));
    expect(
      (await database.db.select().from(timelinePhotos).where(eq(timelinePhotos.id, upload.id)))[0]!
        .status,
    ).toBe('ATTACHED');
  });
  it('keeps surviving link grants scoped when a driver leaves and returns to one trip', async () => {
    const original = await services.tripService.get(tripId);
    const extra = await services.tripService.createAdmin(
      {
        bookingId,
        driverId,
        vehicleId,
        pickupLocation: 'Station',
        destination: 'Airport',
        scheduledAt: new Date(original.scheduledAt.getTime() + 14400000).toISOString(),
        scheduledEndAt: new Date(original.scheduledAt.getTime() + 18000000).toISOString(),
      },
      adminId,
    );
    tripIds.push(extra.id);
    await services.tripService.update(tripId, { driverId: otherId }, adminId);
    await services.tripService.update(tripId, { driverId }, adminId);
    const context = await services.timelineService.context({ token });
    expect(context.trips.map((t) => t.id)).toEqual([extra.id]);
    expect((await post(event({ assignmentVersion: 3 }))).statusCode).toBe(403);
    expect((await post(event({ tripId: extra.id }))).statusCode).toBe(201);
    await services.timelineService.issueLink(bookingId, driverId, adminId, {});
    expect((await post(event({ assignmentVersion: 3 }))).statusCode).toBe(201);
  });
  it('preserves link extensions, closes login reporting, and removes expired temporary uploads', async () => {
    const extendedAt = new Date(clock.getTime() + 86400000 * 70);
    const link = await services.timelineService.issueLink(bookingId, driverId, adminId, {
      expiresAt: extendedAt.toISOString(),
    });
    expect(
      (await services.timelineService.issueLink(bookingId, driverId, adminId, {})).expiresAt,
    ).toBe(link.expiresAt);
    const photo = await services.timelineService.createPhoto(
      { token },
      { tripId, assignmentVersion: 1, contentType: 'image/jpeg', sizeBytes: 100 },
    );
    await services.timelineService.completePhoto({ token }, photo.id);
    await post(event({ photoIds: [photo.id] }));
    clock = new Date(clock.getTime() + 3600000);
    expect(await services.timelineService.cleanupPhotos()).toBe(0);
    const [attached] = await database.db
      .select()
      .from(timelinePhotos)
      .where(eq(timelinePhotos.id, photo.id));
    expect(attached!.status).toBe('ATTACHED');
    expect(attached!.temporaryObjectCleanedAt).not.toBeNull();
    clock = new Date(extendedAt.getTime() - 1000);
    await expect(
      services.timelineService.context({ driverId, accountId: driverAccount }, bookingId),
    ).resolves.toMatchObject({ reportingClosesAt: extendedAt });
    clock = new Date(extendedAt.getTime() + 1000);
    await expect(
      services.timelineService.submit(
        { driverId, accountId: driverAccount },
        event({ type: 'NOTE', note: 'Late' }),
      ),
    ).rejects.toMatchObject({ code: 'DRIVER_REPORTING_WINDOW_CLOSED' });
  });
  it('validates location ranges, correction ownership, and photo assignment versions', async () => {
    expect(
      (
        await post(
          event({
            location: {
              latitude: 91,
              longitude: 0,
              accuracyMeters: 1,
              capturedAt: clock.toISOString(),
            },
          }),
        )
      ).statusCode,
    ).toBe(400);
    const original = await post(event());
    const originalId = original.json<{ data: { id: string } }>().data.id;
    await expect(
      services.timelineService.submit(
        { driverId: otherId, accountId: otherAccount },
        event({
          tripId: otherTripId,
          type: 'CORRECTION',
          correctsEventId: originalId,
          correctionReason: 'Not mine',
          note: 'Change',
        }),
      ),
    ).rejects.toMatchObject({ code: 'TIMELINE_CORRECTION_INVALID' });
    const photo = await services.timelineService.createPhoto(
      { token },
      { tripId, assignmentVersion: 1, contentType: 'image/jpeg', sizeBytes: 100 },
    );
    await services.timelineService.completePhoto({ token }, photo.id);
    const wrongTrip = await services.timelineService.issueLink(bookingId, otherId, adminId, {});
    const otherToken = new URLSearchParams(new URL(wrongTrip.link).hash.slice(1)).get('token')!;
    expect(
      (
        await post(event({ tripId: otherTripId, photoIds: [photo.id] }), {
          authorization: `Bearer ${otherToken}`,
        })
      ).statusCode,
    ).toBe(400);
    await services.tripService.update(tripId, { driverId: otherId }, adminId);
    await expect(
      services.timelineService.completePhoto(
        { driverId: otherId, accountId: otherAccount },
        photo.id,
      ),
    ).rejects.toMatchObject({ code: 'TRIP_ASSIGNMENT_CHANGED' });
  });
  it('denies inactive drivers and exposes readiness only when every active trip is completed', async () => {
    await post(event({ type: 'TRIP_COMPLETED' }));
    const before = await services.timelineService.overview(1, 100, bookingId);
    expect(before.data.every((t) => !t.readyToClose)).toBe(true);
    await services.timelineService.submit(
      { driverId: otherId, accountId: otherAccount },
      event({ tripId: otherTripId, type: 'TRIP_COMPLETED' }),
    );
    expect(
      (await services.timelineService.overview(1, 100, bookingId)).data.every(
        (t) => t.readyToClose,
      ),
    ).toBe(true);
    await database.db
      .update(authAccounts)
      .set({ status: 'DEACTIVATED' })
      .where(eq(authAccounts.id, driverAccount));
    expect((await post(event({ type: 'NOTE', note: 'No access' }))).statusCode).toBe(403);
    await database.db
      .update(authAccounts)
      .set({ status: 'ACTIVE' })
      .where(eq(authAccounts.id, driverAccount));
    expect(
      await database.db
        .select()
        .from(timelineEvents)
        .where(and(eq(timelineEvents.bookingId, bookingId), eq(timelineEvents.driverId, otherId))),
    ).toHaveLength(1);
  });
});
