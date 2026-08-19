import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import {
  auditEvents,
  authAccounts,
  bookings,
  drivers,
  consentVersions,
  feedbackAnswers,
  feedbackHandoffs,
  feedbackReviewEvents,
  feedbackSubmissions,
  questionnaireVersions,
  questionnaires,
  trips,
  vehicles,
} from '../src/database/schema/index.js';
import { passwordHasher } from '../src/modules/auth/password.js';
import { createFieldEncryptor } from '../src/shared/security/field-encryption.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('vehicle and trip APIs', () => {
  let app: FastifyInstance;
  let database: DatabaseClient;
  let adminAccountId: string;
  let driverAccountId: string;
  let driverId: string;
  let otherDriverAccountId: string;
  let otherDriverId: string;
  let vehicleId: string;
  let businessVehicleId: string;
  let bookingId: string;
  let questionnaireId: string;
  let questionnaireVersionId: string;
  let consentVersionId: string;
  const submissionIds: string[] = [];
  const suffix = Date.now().toString(36);
  const password = 'integration-password-123';
  const adminEmail = `trip-admin-${suffix}@example.com`;
  const driverCode = `TRIP-${suffix}`;
  const otherDriverCode = `OTHER-${suffix}`;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      SESSION_IDLE_TTL_HOURS: '72',
      SESSION_ABSOLUTE_TTL_DAYS: '30',
    });
    database = createDatabaseClient(config);
    const passwordHash = await passwordHasher.hash(password);
    const [admin] = await database.db
      .insert(authAccounts)
      .values({
        role: 'ADMIN',
        displayName: 'Trip Admin',
        email: adminEmail,
        passwordHash,
      })
      .returning({ id: authAccounts.id });
    adminAccountId = admin!.id;
    const [booking] = await database.db
      .insert(bookings)
      .values({
        bookingReference: `BOOK-${suffix}`,
        passengerName: 'Integration Passenger',
        passengerPhoneCiphertext: createFieldEncryptor(config.dataEncryptionKey).encrypt(
          '+919876543210',
        ),
        startsAt: new Date('2029-01-01T00:00:00.000Z'),
        endsAt: new Date('2033-01-01T00:00:00.000Z'),
        createdByAccountId: adminAccountId,
      })
      .returning({ id: bookings.id });
    bookingId = booking!.id;

    const [driverAccount] = await database.db
      .insert(authAccounts)
      .values({
        role: 'DRIVER',
        displayName: 'Assigned Driver',
        email: `trip-driver-${suffix}@example.com`,
        passwordHash,
      })
      .returning({ id: authAccounts.id });
    driverAccountId = driverAccount!.id;
    const [driver] = await database.db
      .insert(drivers)
      .values({
        accountId: driverAccountId,
        driverCode,
        sourceType: 'AGENCY',
      })
      .returning({ id: drivers.id });
    driverId = driver!.id;

    const [otherAccount] = await database.db
      .insert(authAccounts)
      .values({
        role: 'DRIVER',
        displayName: 'Other Driver',
        email: `other-driver-${suffix}@example.com`,
        passwordHash,
      })
      .returning({ id: authAccounts.id });
    otherDriverAccountId = otherAccount!.id;
    const [otherDriver] = await database.db
      .insert(drivers)
      .values({
        accountId: otherDriverAccountId,
        driverCode: otherDriverCode,
        sourceType: 'AGENCY',
      })
      .returning({ id: drivers.id });
    otherDriverId = otherDriver!.id;

    app = await buildApp({
      exposeDocs: false,
      services: createApplicationServices(database.db, config),
    });
  });

  afterAll(async () => {
    await app?.close();
    if (submissionIds.length) {
      await database.db
        .delete(feedbackReviewEvents)
        .where(inArray(feedbackReviewEvents.feedbackSubmissionId, submissionIds));
      await database.db
        .delete(feedbackAnswers)
        .where(inArray(feedbackAnswers.feedbackSubmissionId, submissionIds));
      await database.db
        .delete(feedbackSubmissions)
        .where(inArray(feedbackSubmissions.id, submissionIds));
    }
    await database.db
      .delete(trips)
      .where(
        inArray(trips.createdByAccountId, [adminAccountId, driverAccountId, otherDriverAccountId]),
      );
    await database.db.delete(bookings).where(eq(bookings.id, bookingId));
    if (questionnaireId) {
      await database.db
        .delete(questionnaireVersions)
        .where(eq(questionnaireVersions.questionnaireId, questionnaireId));
      await database.db.delete(questionnaires).where(eq(questionnaires.id, questionnaireId));
    }
    if (consentVersionId)
      await database.db.delete(consentVersions).where(eq(consentVersions.id, consentVersionId));
    await database.db
      .delete(auditEvents)
      .where(
        inArray(auditEvents.actorAccountId, [
          adminAccountId,
          driverAccountId,
          otherDriverAccountId,
        ]),
      );
    await database.db.delete(drivers).where(inArray(drivers.id, [driverId, otherDriverId]));
    await database.db
      .delete(authAccounts)
      .where(inArray(authAccounts.id, [adminAccountId, driverAccountId, otherDriverAccountId]));
    const vehicleIds = [vehicleId, businessVehicleId].filter(Boolean);
    if (vehicleIds.length)
      await database.db.delete(vehicles).where(inArray(vehicles.id, vehicleIds));
    await database.close();
  });

  it('manages vehicles and the admin-assigned trip lifecycle', async () => {
    const adminCookie = await login('/api/v1/auth/admin/login', { email: adminEmail, password });
    const bookingResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bookings/${bookingId}`,
      headers: { cookie: adminCookie },
    });
    expect(bookingResponse.statusCode, bookingResponse.body).toBe(200);
    expect(bookingResponse.json()).toMatchObject({
      data: {
        id: bookingId,
        bookingReference: `BOOK-${suffix}`,
        passengerName: 'Integration Passenger',
        passengerPhone: '+919876543210',
        tripCount: 0,
        trips: [],
      },
    });
    const vehicleResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/vehicles',
      headers: { cookie: adminCookie },
      payload: { registrationNumber: `wb 01 ${suffix}`, displayName: 'Toyota Crysta' },
    });
    expect(vehicleResponse.statusCode).toBe(201);
    vehicleId = vehicleResponse.json<{ data: { id: string; registrationNumber: string } }>().data
      .id;
    expect(vehicleResponse.json()).toMatchObject({
      data: { registrationNumber: `WB 01 ${suffix.toUpperCase()}` },
    });

    const vehicleUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/vehicles/${vehicleId}`,
      headers: { cookie: adminCookie },
      payload: { displayName: 'Updated Crysta' },
    });
    expect(vehicleUpdate.statusCode).toBe(200);

    const consent = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/consent-versions',
      headers: { cookie: adminCookie },
      payload: { content: 'I consent to the collection and processing of this feedback.' },
    });
    expect(consent.statusCode).toBe(201);
    consentVersionId = consent.json<{ data: { id: string } }>().data.id;

    const questionnaire = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/questionnaires',
      headers: { cookie: adminCookie },
      payload: { name: `Core feedback ${suffix}` },
    });
    expect(questionnaire.statusCode).toBe(201);
    const questionnaireData = questionnaire.json<{
      data: { questionnaire: { id: string }; draftVersionId: string };
    }>().data;
    questionnaireId = questionnaireData.questionnaire.id;
    questionnaireVersionId = questionnaireData.draftVersionId;

    const questionnaireList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/questionnaires?page=1&pageSize=1',
      headers: { cookie: adminCookie },
    });
    expect(questionnaireList.statusCode).toBe(200);
    expect(questionnaireList.json()).toMatchObject({
      data: [{ id: questionnaireId }],
      pagination: { page: 1, pageSize: 1, total: 1 },
    });

    const questions = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/questionnaires/${questionnaireId}/versions/${questionnaireVersionId}/questions`,
      headers: { cookie: adminCookie },
      payload: {
        questions: [
          {
            stableKey: 'overall_experience',
            prompt: 'How was your overall experience?',
            questionType: 'STAR_RATING',
            category: 'OVERALL_EXPERIENCE',
            isRequired: true,
            contributesToScore: true,
            scoreMin: 1,
            scoreMax: 5,
            options: [],
          },
          {
            stableKey: 'recommend_driver',
            prompt: 'Would you recommend this driver?',
            questionType: 'YES_NO',
            category: 'PROFESSIONALISM',
            isRequired: true,
            contributesToScore: true,
            options: [
              { valueKey: 'yes', label: 'Yes', scoreValue: 5 },
              { valueKey: 'no', label: 'No', scoreValue: 1 },
            ],
          },
          {
            stableKey: 'comments',
            prompt: 'Additional comments',
            questionType: 'TEXT',
            category: 'CUSTOM',
            isRequired: false,
            contributesToScore: false,
            options: [],
          },
        ],
      },
    });
    expect(questions.statusCode).toBe(200);

    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/questionnaires/${questionnaireId}/versions/${questionnaireVersionId}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(publish.statusCode).toBe(200);
    const publishedData = publish.json<{
      data: { status: string; questions: { displayOrder: number }[] };
    }>().data;
    expect(publishedData.status).toBe('ACTIVE');
    expect(publishedData.questions.map((question) => question.displayOrder)).toEqual([0, 1, 2]);

    const immutable = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/questionnaires/${questionnaireId}/versions/${questionnaireVersionId}/questions`,
      headers: { cookie: adminCookie },
      payload: { questions: [] },
    });
    expect(immutable.statusCode).toBe(409);

    const clonedDraft = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/questionnaires/${questionnaireId}/versions`,
      headers: { cookie: adminCookie },
    });
    expect(clonedDraft.statusCode).toBe(201);
    const clonedDraftId = clonedDraft.json<{ data: { id: string } }>().data.id;
    expect(clonedDraft.json()).toMatchObject({ data: { versionNumber: 2, status: 'DRAFT' } });
    const firstVersionPage = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/questionnaires/${questionnaireId}/versions?page=1&pageSize=1`,
      headers: { cookie: adminCookie },
    });
    expect(firstVersionPage.statusCode).toBe(200);
    expect(firstVersionPage.json()).toMatchObject({
      data: [{ id: clonedDraftId, versionNumber: 2 }],
      pagination: { page: 1, pageSize: 1, total: 2 },
    });
    const secondVersionPage = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/questionnaires/${questionnaireId}/versions?page=2&pageSize=1`,
      headers: { cookie: adminCookie },
    });
    expect(secondVersionPage.statusCode).toBe(200);
    expect(secondVersionPage.json()).toMatchObject({
      data: [{ id: questionnaireVersionId, versionNumber: 1 }],
      pagination: { page: 2, pageSize: 1, total: 2 },
    });
    const archivedDraft = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/questionnaires/${questionnaireId}/versions/${clonedDraftId}/archive`,
      headers: { cookie: adminCookie },
    });
    expect(archivedDraft.statusCode).toBe(200);
    expect(archivedDraft.json()).toMatchObject({ data: { status: 'ARCHIVED' } });

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/questionnaires/${questionnaireId}`,
      headers: { cookie: adminCookie },
      payload: { name: `Passenger feedback ${suffix}` },
    });
    expect(renamed.statusCode).toBe(200);

    const tripResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trips',
      headers: { cookie: adminCookie },
      payload: tripPayload(driverId),
    });
    expect(tripResponse.statusCode).toBe(201);
    const tripId = tripResponse.json<{ data: { id: string } }>().data.id;
    expect(tripResponse.json()).toMatchObject({
      data: {
        booking: { id: bookingId, bookingReference: `BOOK-${suffix}` },
        creationSource: 'ADMIN_ASSIGNED',
        status: 'READY',
        vehicle: { displayName: 'Updated Crysta' },
        driver: { id: driverId, sourceType: 'AGENCY' },
      },
    });
    const bookingWithTrip = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bookings/${bookingId}`,
      headers: { cookie: adminCookie },
    });
    expect(bookingWithTrip.json()).toMatchObject({
      data: { tripCount: 1, trips: [{ id: tripId }] },
    });

    const driverCookie = await login('/api/v1/auth/driver/login', { driverCode, password });
    const assigned = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/trips',
      headers: { cookie: driverCookie },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({ pagination: { total: 1 }, data: [{ id: tripId }] });

    const otherCookie = await login('/api/v1/auth/driver/login', {
      driverCode: otherDriverCode,
      password,
    });
    const forbiddenByOwnership = await app.inject({
      method: 'GET',
      url: `/api/v1/driver/trips/${tripId}`,
      headers: { cookie: otherCookie },
    });
    expect(forbiddenByOwnership.statusCode).toBe(404);

    const [adminFeedbackLink, driverFeedbackLink, otherDriverFeedbackLink] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/v1/admin/trips/${tripId}/feedback-link`,
        headers: { cookie: adminCookie },
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/driver/trips/${tripId}/feedback-link`,
        headers: { cookie: driverCookie },
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/driver/trips/${tripId}/feedback-link`,
        headers: { cookie: otherCookie },
      }),
    ]);
    expect(adminFeedbackLink.statusCode, adminFeedbackLink.body).toBe(200);
    expect(driverFeedbackLink.statusCode, driverFeedbackLink.body).toBe(200);
    expect(otherDriverFeedbackLink.statusCode).toBe(404);
    const otherDriverPreparation = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/trips/${tripId}/start-feedback`,
      headers: { cookie: otherCookie },
    });
    expect(otherDriverPreparation.statusCode).toBe(404);
    const adminLinkData = adminFeedbackLink.json<{
      data: {
        tripId: string;
        feedbackLink: string;
        feedbackAccessTokenExpiresAt: string;
        recipient: { name: string; phone: string | null };
      };
    }>().data;
    expect(adminLinkData.feedbackLink).toMatch(/^http:\/\/localhost:3001\/feedback\?token=/);
    expect(adminLinkData.recipient).toEqual({
      name: 'Integration Passenger',
      phone: '+919876543210',
    });
    expect(driverFeedbackLink.json()).toEqual({
      data: {
        tripId: adminLinkData.tripId,
        feedbackLink: adminLinkData.feedbackLink,
        feedbackAccessTokenExpiresAt: adminLinkData.feedbackAccessTokenExpiresAt,
      },
    });
    expect(adminFeedbackLink.json()).not.toHaveProperty('data.feedbackAccessToken');
    expect(driverFeedbackLink.json()).not.toHaveProperty('data.feedbackAccessToken');

    const handoffPreparation = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/trips/${tripId}/start-feedback`,
      headers: { cookie: driverCookie },
    });
    expect(handoffPreparation.statusCode).toBe(200);
    const prepared = handoffPreparation.json<{
      data: {
        status: string;
        startedFeedbackAt: string | null;
        feedbackAccessToken: string;
        feedbackLink: string;
      };
    }>().data;
    expect(prepared).toMatchObject({
      status: 'READY',
      startedFeedbackAt: null,
      feedbackLink: adminLinkData.feedbackLink,
    });
    expect(new URL(prepared.feedbackLink).searchParams.get('token')).toBe(
      prepared.feedbackAccessToken,
    );

    const context = await app.inject({
      method: 'GET',
      url: '/api/v1/passenger/feedback/context',
      headers: { authorization: `Bearer ${prepared.feedbackAccessToken}` },
    });
    expect(context.statusCode, context.body).toBe(200);
    const [readyTrip] = await database.db
      .select({ status: trips.status, startedFeedbackAt: trips.startedFeedbackAt })
      .from(trips)
      .where(eq(trips.id, tripId));
    expect(readyTrip).toEqual({ status: 'READY', startedFeedbackAt: null });

    const passengerStart = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/start',
      headers: { authorization: `Bearer ${prepared.feedbackAccessToken}` },
    });
    expect(passengerStart.statusCode, passengerStart.body).toBe(200);
    expect(passengerStart.json()).toMatchObject({
      data: { tripId, status: 'FEEDBACK_STARTED' },
    });
    expect(
      Date.parse(
        passengerStart.json<{ data: { startedFeedbackAt: string } }>().data.startedFeedbackAt,
      ),
    ).not.toBeNaN();
    const startedFeedbackLink = await app.inject({
      method: 'GET',
      url: `/api/v1/driver/trips/${tripId}/feedback-link`,
      headers: { cookie: driverCookie },
    });
    expect(startedFeedbackLink.statusCode, startedFeedbackLink.body).toBe(200);
    expect(startedFeedbackLink.json()).toEqual({
      data: {
        tripId: adminLinkData.tripId,
        feedbackLink: adminLinkData.feedbackLink,
        feedbackAccessTokenExpiresAt: adminLinkData.feedbackAccessTokenExpiresAt,
      },
    });

    const noLongerEditable = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/trips/${tripId}`,
      headers: { cookie: adminCookie },
      payload: { destination: 'Changed too late' },
    });
    expect(noLongerEditable.statusCode).toBe(409);

    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/trips/${tripId}/archive`,
      headers: { cookie: adminCookie },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ data: { status: 'ARCHIVED' } });
    const startArchived = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/start',
      headers: { authorization: `Bearer ${prepared.feedbackAccessToken}` },
    });
    expect(startArchived.statusCode).toBe(409);
    expect(startArchived.json()).toMatchObject({
      error: { code: 'FEEDBACK_HANDOFF_UNAVAILABLE' },
    });
  }, 20_000);

  it('enforces trip assignment availability and scheduling rules', async () => {
    const adminCookie = await login('/api/v1/auth/admin/login', { email: adminEmail, password });
    const vehicleResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/vehicles',
      headers: { cookie: adminCookie },
      payload: { registrationNumber: `wb 02 ${suffix}`, displayName: 'Backup Crysta' },
    });
    expect(vehicleResponse.statusCode).toBe(201);
    businessVehicleId = vehicleResponse.json<{ data: { id: string } }>().data.id;

    const base = {
      ...tripPayload(driverId),
      scheduledAt: '2031-08-10T04:30:00.000Z',
      scheduledEndAt: '2031-08-10T05:30:00.000Z',
    };
    const create = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/trips',
        headers: { cookie: adminCookie },
        payload,
      });

    expect((await create(base)).statusCode).toBe(201);

    const anotherTripInBooking = await create({
      ...base,
      driverId: otherDriverId,
      vehicleId: businessVehicleId,
      scheduledAt: '2031-08-10T07:00:00.000Z',
      scheduledEndAt: '2031-08-10T08:00:00.000Z',
    });
    expect(anotherTripInBooking.statusCode).toBe(201);
    expect(anotherTripInBooking.json()).toMatchObject({
      data: { booking: { id: bookingId } },
    });

    const driverConflict = await create({
      ...base,
      vehicleId: businessVehicleId,
    });
    expect(driverConflict.statusCode).toBe(409);
    expect(driverConflict.json()).toMatchObject({
      error: { code: 'DRIVER_SCHEDULE_CONFLICT' },
    });

    const vehicleConflict = await create({
      ...base,
      driverId: otherDriverId,
    });
    expect(vehicleConflict.statusCode).toBe(409);
    expect(vehicleConflict.json()).toMatchObject({
      error: { code: 'VEHICLE_SCHEDULE_CONFLICT' },
    });

    const past = await create({
      ...base,
      scheduledAt: '2020-01-01T04:30:00.000Z',
      scheduledEndAt: '2020-01-01T05:30:00.000Z',
    });
    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({
      error: { code: 'TRIP_CANNOT_BE_SCHEDULED_IN_PAST' },
    });

    const sameLocation = await create({
      ...base,
      pickupLocation: '  Kolkata   Airport ',
      destination: 'kolkata airport',
      scheduledAt: '2031-08-11T04:30:00.000Z',
      scheduledEndAt: '2031-08-11T05:30:00.000Z',
    });
    expect(sameLocation.statusCode).toBe(400);
    expect(sameLocation.json()).toMatchObject({
      error: { code: 'TRIP_LOCATIONS_MUST_DIFFER' },
    });

    const availabilityUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/drivers/${driverId}`,
      headers: { cookie: adminCookie },
      payload: { assignmentEnabled: false },
    });
    expect(availabilityUpdate.statusCode).toBe(200);
    const unavailable = await create({
      ...base,
      scheduledAt: '2031-08-11T04:30:00.000Z',
      scheduledEndAt: '2031-08-11T05:30:00.000Z',
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({
      error: { code: 'DRIVER_NOT_AVAILABLE_FOR_ASSIGNMENT' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/drivers/${driverId}`,
      headers: { cookie: adminCookie },
      payload: { assignmentEnabled: true },
    });

    const leaveResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/leaves`,
      headers: { cookie: adminCookie },
      payload: {
        startsAt: '2031-08-11T04:00:00.000Z',
        endsAt: '2031-08-11T06:00:00.000Z',
        reason: 'Planned leave',
      },
    });
    expect(leaveResponse.statusCode).toBe(201);
    const leaveId = leaveResponse.json<{ data: { id: string } }>().data.id;
    const leaves = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/drivers/${driverId}/leaves?page=1&pageSize=1`,
      headers: { cookie: adminCookie },
    });
    expect(leaves.statusCode).toBe(200);
    expect(leaves.json()).toMatchObject({
      data: [{ id: leaveId }],
      pagination: { page: 1, pageSize: 1, total: 1 },
    });
    const onLeave = await create({
      ...base,
      scheduledAt: '2031-08-11T04:30:00.000Z',
      scheduledEndAt: '2031-08-11T05:30:00.000Z',
    });
    expect(onLeave.statusCode).toBe(409);
    expect(onLeave.json()).toMatchObject({ error: { code: 'DRIVER_ON_LEAVE' } });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/drivers/${driverId}/leaves/${leaveId}`,
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(204);

    const shiftUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/drivers/${driverId}`,
      headers: { cookie: adminCookie },
      payload: {
        shiftStartTime: '10:00',
        shiftEndTime: '18:00',
        timeZone: 'Asia/Kolkata',
      },
    });
    expect(shiftUpdate.statusCode).toBe(200);
    const outsideShift = await create({
      ...base,
      scheduledAt: '2031-08-12T03:30:00.000Z',
      scheduledEndAt: '2031-08-12T04:30:00.000Z',
    });
    expect(outsideShift.statusCode).toBe(409);
    expect(outsideShift.json()).toMatchObject({
      error: { code: 'TRIP_OUTSIDE_DRIVER_SHIFT' },
    });

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/drivers/${driverId}`,
      headers: { cookie: adminCookie },
      payload: {
        shiftStartTime: null,
        shiftEndTime: null,
        maxDailyDutyMinutes: 90,
      },
    });
    const dutyLimit = await create({
      ...base,
      vehicleId: businessVehicleId,
      scheduledAt: '2031-08-10T05:30:00.000Z',
      scheduledEndAt: '2031-08-10T06:15:00.000Z',
    });
    expect(dutyLimit.statusCode).toBe(409);
    expect(dutyLimit.json()).toMatchObject({
      error: { code: 'DRIVER_DAILY_DUTY_LIMIT_EXCEEDED' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/drivers/${driverId}`,
      headers: { cookie: adminCookie },
      payload: { maxDailyDutyMinutes: 720 },
    });
  }, 20_000);

  it('submits driver-entered trip feedback idempotently and rejects inactive vehicles', async () => {
    const adminCookie = await login('/api/v1/auth/admin/login', { email: adminEmail, password });
    const driverCookie = await login('/api/v1/auth/driver/login', { driverCode, password });
    const settingsUpdate = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      headers: { cookie: adminCookie },
      payload: {
        agencyName: 'Eastern Risen Test',
        timezone: 'Asia/Kolkata',
        defaultThankYouMessage: 'Thank you from the integration test.',
        negativeFeedbackThreshold: 4,
      },
    });
    expect(settingsUpdate.statusCode, settingsUpdate.body).toBe(200);
    expect(settingsUpdate.json()).toMatchObject({
      data: {
        agencyName: 'Eastern Risen Test',
        negativeFeedbackThreshold: 4,
      },
    });
    const payload = tripPayload(driverId);
    const selfCreated = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/trips',
      headers: { cookie: driverCookie },
      payload: {
        bookingId: payload.bookingId,
        pickupLocation: payload.pickupLocation,
        destination: payload.destination,
        scheduledAt: payload.scheduledAt,
        scheduledEndAt: payload.scheduledEndAt,
        vehicleId: payload.vehicleId,
      },
    });
    expect(selfCreated.statusCode).toBe(201);
    const selfTripId = selfCreated.json<{ data: { id: string } }>().data.id;
    expect(selfCreated.json()).toMatchObject({
      data: { creationSource: 'DRIVER_ENTERED', driver: { id: driverId } },
    });

    const concurrentStarts = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/driver/trips/${selfTripId}/start-feedback`,
          headers: { cookie: driverCookie },
        }),
      ),
    );
    expect(concurrentStarts.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    const accessTokens = concurrentStarts.map(
      (response) =>
        response.json<{ data: { feedbackAccessToken: string } }>().data.feedbackAccessToken,
    );
    expect(new Set(accessTokens).size).toBe(1);
    const accessToken = accessTokens[0]!;

    const [preparedTrip] = await database.db
      .select({ status: trips.status, startedFeedbackAt: trips.startedFeedbackAt })
      .from(trips)
      .where(eq(trips.id, selfTripId));
    expect(preparedTrip).toEqual({ status: 'READY', startedFeedbackAt: null });

    const context = await app.inject({
      method: 'GET',
      url: '/api/v1/passenger/feedback/context',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(context.statusCode).toBe(200);
    const contextData = context.json<{
      data: {
        completion: {
          agencyName: string;
          timezone: string;
          thankYouMessage: string;
        };
        questionnaire: {
          questionnaireVersionId: string;
          questions: { id: string; stableKey: string }[];
        };
        consent: { id: string };
      };
    }>().data;
    expect(contextData.questionnaire.questionnaireVersionId).toBe(questionnaireVersionId);
    expect(contextData.questionnaire.questions).toHaveLength(3);
    expect(contextData.completion).toEqual({
      agencyName: 'Eastern Risen Test',
      timezone: 'Asia/Kolkata',
      thankYouMessage: 'Thank you from the integration test.',
    });
    const [tripAfterContext] = await database.db
      .select({ status: trips.status, startedFeedbackAt: trips.startedFeedbackAt })
      .from(trips)
      .where(eq(trips.id, selfTripId));
    expect(tripAfterContext).toEqual({ status: 'READY', startedFeedbackAt: null });
    const [pinnedVersions] = await database.db
      .select({
        questionnaireVersionId: feedbackHandoffs.questionnaireVersionId,
        consentVersionId: feedbackHandoffs.consentVersionId,
      })
      .from(feedbackHandoffs)
      .where(eq(feedbackHandoffs.tripId, selfTripId));
    expect(pinnedVersions).toEqual({
      questionnaireVersionId: contextData.questionnaire.questionnaireVersionId,
      consentVersionId: contextData.consent.id,
    });
    const questionId = (stableKey: string) =>
      contextData.questionnaire.questions.find((question) => question.stableKey === stableKey)!.id;

    const clientSubmissionId = crypto.randomUUID();
    const submissionPayload = {
      clientSubmissionId,
      questionnaireVersionId,
      questionnaireSnapshot: contextData.questionnaire,
      respondent: {
        name: 'Passenger One',
        phone: '+919876543210',
        email: 'passenger@example.com',
        bookingReference: `BOOK-${suffix}`,
        consentAccepted: true,
        consentedAt: '2026-08-10T06:30:00.000Z',
      },
      answers: [
        { questionId: questionId('overall_experience'), value: 5 },
        { questionId: questionId('recommend_driver'), value: true },
        { questionId: questionId('comments'), value: 'Excellent service' },
      ],
      submittedAt: '2026-08-10T06:31:00.000Z',
      submissionMode: 'OFFLINE_SYNC',
    };

    const submittedBeforeStart = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/submissions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: submissionPayload,
    });
    expect(submittedBeforeStart.statusCode).toBe(409);
    expect(submittedBeforeStart.json()).toMatchObject({
      error: { code: 'FEEDBACK_HANDOFF_UNAVAILABLE' },
    });
    const [handoffBeforeStart] = await database.db
      .select({ consumedAt: feedbackHandoffs.consumedAt })
      .from(feedbackHandoffs)
      .where(eq(feedbackHandoffs.tripId, selfTripId));
    expect(handoffBeforeStart?.consumedAt).toBeNull();

    const passengerStarts = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/passenger/feedback/start',
          headers: { authorization: `Bearer ${accessToken}` },
        }),
      ),
    );
    expect(passengerStarts.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    const passengerStartData = passengerStarts.map(
      (response) =>
        response.json<{
          data: { tripId: string; status: string; startedFeedbackAt: string };
        }>().data,
    );
    expect(new Set(passengerStartData.map((result) => result.startedFeedbackAt)).size).toBe(1);
    expect(passengerStartData[0]).toMatchObject({
      tripId: selfTripId,
      status: 'FEEDBACK_STARTED',
    });
    const [versionsAfterStart] = await database.db
      .select({
        questionnaireVersionId: feedbackHandoffs.questionnaireVersionId,
        consentVersionId: feedbackHandoffs.consentVersionId,
      })
      .from(feedbackHandoffs)
      .where(eq(feedbackHandoffs.tripId, selfTripId));
    expect(versionsAfterStart).toEqual(pinnedVersions);

    const tampered = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/submissions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        ...submissionPayload,
        questionnaireSnapshot: { ...contextData.questionnaire, versionNumber: 999 },
      },
    });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json()).toMatchObject({ error: { code: 'QUESTIONNAIRE_SNAPSHOT_INVALID' } });

    const submit = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/submissions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: submissionPayload,
    });
    expect(submit.statusCode, submit.body).toBe(201);
    const receipt = submit.json<{ data: { id: string } }>().data;
    submissionIds.push(receipt.id);
    expect(submit.json()).toMatchObject({ data: { replayed: false, rewardEligible: false } });

    const [consumedHandoff] = await database.db
      .select({ consumedAt: feedbackHandoffs.consumedAt })
      .from(feedbackHandoffs)
      .where(eq(feedbackHandoffs.tripId, selfTripId));
    expect(consumedHandoff?.consumedAt).toBeInstanceOf(Date);
    const startAfterConsumption = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/start',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(startAfterConsumption.statusCode).toBe(401);
    expect(startAfterConsumption.json()).toMatchObject({
      error: { code: 'FEEDBACK_HANDOFF_INVALID' },
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/submissions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: submissionPayload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ data: { id: receipt.id, replayed: true } });

    const duplicateTrip = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/submissions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ...submissionPayload, clientSubmissionId: crypto.randomUUID() },
    });
    expect(duplicateTrip.statusCode).toBe(409);
    expect(duplicateTrip.json()).toMatchObject({
      error: { code: 'TRIP_FEEDBACK_ALREADY_SUBMITTED' },
    });

    const stored = await database.db
      .select({
        phone: feedbackSubmissions.respondentPhoneCiphertext,
        email: feedbackSubmissions.respondentEmailCiphertext,
      })
      .from(feedbackSubmissions)
      .where(eq(feedbackSubmissions.id, receipt.id))
      .limit(1);
    expect(stored[0]?.phone).toMatch(/^v1\./);
    expect(stored[0]?.phone).not.toContain('9876543210');
    expect(stored[0]?.email).not.toContain('passenger@example.com');

    const driverPerformance = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/performance?month=2026-08',
      headers: { cookie: driverCookie },
    });
    expect(driverPerformance.statusCode, driverPerformance.body).toBe(200);
    expect(driverPerformance.json()).toMatchObject({
      data: {
        driverId,
        overall: { averageScore: 5, responseCount: 1, answerCount: 2 },
        meta: { timezone: 'Asia/Kolkata', dateBasis: 'SUBMITTED_AT', month: '2026-08' },
      },
    });

    const analytics = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics?month=2026-08&driverId=${driverId}`,
      headers: { cookie: adminCookie },
    });
    expect(analytics.statusCode, analytics.body).toBe(200);
    expect(analytics.json()).toMatchObject({
      data: {
        overall: { averageScore: 5, responseCount: 1, answerCount: 2 },
        negativeFeedbackCount: 0,
        negativeFeedbackThreshold: 4,
        drivers: [{ driver: { id: driverId } }],
      },
    });

    const feedbackList = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/feedback?month=2026-08&driverId=${driverId}`,
      headers: { cookie: adminCookie },
    });
    expect(feedbackList.statusCode, feedbackList.body).toBe(200);
    expect(feedbackList.json()).toMatchObject({
      data: [{ id: receipt.id, respondentName: 'Passenger One', overallScore: 5 }],
      pagination: { total: 1 },
      meta: { timezone: 'Asia/Kolkata', dateBasis: 'SUBMITTED_AT' },
    });
    const negativeFeedbackList = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/feedback?month=2026-08&driverId=${driverId}&negativeOnly=true`,
      headers: { cookie: adminCookie },
    });
    expect(negativeFeedbackList.statusCode, negativeFeedbackList.body).toBe(200);
    expect(negativeFeedbackList.json()).toMatchObject({
      data: [],
      pagination: { total: 0 },
    });

    const feedbackDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/feedback/${receipt.id}`,
      headers: { cookie: adminCookie },
    });
    expect(feedbackDetail.statusCode, feedbackDetail.body).toBe(200);
    expect(feedbackDetail.json()).toMatchObject({
      data: {
        id: receipt.id,
        respondent: {
          phone: '+919876543210',
          email: 'passenger@example.com',
        },
        answers: [
          { stableKey: 'overall_experience', numericScore: 5 },
          { stableKey: 'recommend_driver', numericScore: 5 },
          { stableKey: 'comments', numericScore: null },
        ],
        reviewHistory: [],
      },
    });

    const flag = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feedback/${receipt.id}/review-state`,
      headers: { cookie: adminCookie },
      payload: { state: 'FLAGGED', reason: 'Needs review' },
    });
    expect(flag.statusCode, flag.body).toBe(200);
    expect(flag.json()).toMatchObject({ data: { reviewState: 'FLAGGED' } });

    const unflag = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feedback/${receipt.id}/review-state`,
      headers: { cookie: adminCookie },
      payload: { state: 'NORMAL', reason: 'Reviewed' },
    });
    expect(unflag.statusCode, unflag.body).toBe(200);
    expect(unflag.json()).toMatchObject({ data: { reviewState: 'NORMAL' } });

    const reflag = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feedback/${receipt.id}/review-state`,
      headers: { cookie: adminCookie },
      payload: { state: 'FLAGGED' },
    });
    expect(reflag.statusCode, reflag.body).toBe(200);

    const archiveWithoutReason = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feedback/${receipt.id}/review-state`,
      headers: { cookie: adminCookie },
      payload: { state: 'ARCHIVED' },
    });
    expect(archiveWithoutReason.statusCode).toBe(400);
    expect(archiveWithoutReason.json()).toMatchObject({
      error: { code: 'FEEDBACK_ARCHIVE_REASON_REQUIRED' },
    });

    const archive = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feedback/${receipt.id}/review-state`,
      headers: { cookie: adminCookie },
      payload: { state: 'ARCHIVED', reason: 'Duplicate operational record' },
    });
    expect(archive.statusCode, archive.body).toBe(200);
    expect(archive.json()).toMatchObject({ data: { reviewState: 'ARCHIVED' } });

    const archivedPerformance = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/performance?month=2026-08',
      headers: { cookie: driverCookie },
    });
    expect(archivedPerformance.statusCode, archivedPerformance.body).toBe(200);
    expect(archivedPerformance.json()).toMatchObject({
      data: { overall: { averageScore: null, responseCount: 0, answerCount: 0 } },
    });

    const clearThreshold = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      headers: { cookie: adminCookie },
      payload: { negativeFeedbackThreshold: null },
    });
    expect(clearThreshold.statusCode, clearThreshold.body).toBe(200);
    const unavailableNegativeFilter = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/feedback?negativeOnly=true',
      headers: { cookie: adminCookie },
    });
    expect(unavailableNegativeFilter.statusCode).toBe(409);
    expect(unavailableNegativeFilter.json()).toMatchObject({
      error: { code: 'NEGATIVE_FEEDBACK_THRESHOLD_REQUIRED' },
    });

    const submittedTrip = await database.db
      .select({ status: trips.status })
      .from(trips)
      .where(eq(trips.id, selfTripId))
      .limit(1);
    expect(submittedTrip[0]?.status).toBe('SUBMITTED');

    const expiryTrip = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/trips',
      headers: { cookie: driverCookie },
      payload: {
        bookingId: payload.bookingId,
        pickupLocation: payload.pickupLocation,
        destination: payload.destination,
        scheduledAt: '2030-08-10T06:30:00.000Z',
        scheduledEndAt: '2030-08-10T07:30:00.000Z',
        vehicleId: payload.vehicleId,
      },
    });
    const expiryTripId = expiryTrip.json<{ data: { id: string } }>().data.id;
    const expiryStart = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/trips/${expiryTripId}/start-feedback`,
      headers: { cookie: driverCookie },
    });
    const expiredToken = expiryStart.json<{ data: { feedbackAccessToken: string } }>().data
      .feedbackAccessToken;
    await database.db
      .update(feedbackHandoffs)
      .set({ expiresAt: new Date(0) })
      .where(eq(feedbackHandoffs.tripId, expiryTripId));
    const expiredContext = await app.inject({
      method: 'GET',
      url: '/api/v1/passenger/feedback/context',
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    expect(expiredContext.statusCode).toBe(401);
    expect(expiredContext.json()).toMatchObject({ error: { code: 'FEEDBACK_HANDOFF_INVALID' } });
    const expiredStart = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/start',
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    expect(expiredStart.statusCode).toBe(401);
    expect(expiredStart.json()).toMatchObject({
      error: { code: 'FEEDBACK_HANDOFF_INVALID' },
    });

    const deactivate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/vehicles/${vehicleId}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'DEACTIVATED' },
    });
    expect(deactivate.statusCode).toBe(200);

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trips',
      headers: { cookie: adminCookie },
      payload: tripPayload(driverId),
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: 'ACTIVE_VEHICLE_NOT_FOUND' } });
  }, 20_000);

  async function login(url: string, payload: Record<string, string>): Promise<string> {
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return cookie!.split(';', 1)[0]!;
  }

  function tripPayload(assignedDriverId: string) {
    return {
      bookingId,
      pickupLocation: 'Kolkata Airport',
      destination: 'Darjeeling',
      scheduledAt: '2030-08-10T04:30:00.000Z',
      scheduledEndAt: '2030-08-10T05:30:00.000Z',
      vehicleId,
      driverId: assignedDriverId,
    };
  }
});
