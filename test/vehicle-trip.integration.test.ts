import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import {
  auditEvents,
  authAccounts,
  bookingDriverEngagements,
  bookings,
  drivers,
  consentVersions,
  feedbackAnswers,
  feedbackHandoffs,
  feedbackHandoffSections,
  feedbackReviewEvents,
  feedbackSubmissions,
  feedbackSubmissionSections,
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
  const extraQuestionnaireIds: string[] = [];
  let consentVersionId: string;
  const submissionIds: string[] = [];
  const extraBookingIds: string[] = [];
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
        .delete(feedbackSubmissionSections)
        .where(inArray(feedbackSubmissionSections.feedbackSubmissionId, submissionIds));
      await database.db
        .delete(feedbackSubmissions)
        .where(inArray(feedbackSubmissions.id, submissionIds));
    }
    await database.db
      .delete(trips)
      .where(
        inArray(trips.createdByAccountId, [adminAccountId, driverAccountId, otherDriverAccountId]),
      );
    await database.db
      .delete(bookingDriverEngagements)
      .where(inArray(bookingDriverEngagements.bookingId, [bookingId, ...extraBookingIds]));
    await database.db.delete(bookings).where(inArray(bookings.id, [bookingId, ...extraBookingIds]));
    if (questionnaireId) {
      await database.db
        .delete(questionnaireVersions)
        .where(
          inArray(questionnaireVersions.questionnaireId, [
            questionnaireId,
            ...extraQuestionnaireIds,
          ]),
        );
      await database.db
        .delete(questionnaires)
        .where(inArray(questionnaires.id, [questionnaireId, ...extraQuestionnaireIds]));
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
        engagements: [],
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
      payload: { name: `Core feedback ${suffix}`, purpose: 'DRIVER_FEEDBACK' },
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
    await publishBoundaryQuestionnaire(adminCookie, 'ARRIVAL_EXPERIENCE', 'ARRIVAL_EXPERIENCE');
    await publishBoundaryQuestionnaire(adminCookie, 'TOUR_EXPERIENCE', 'TOUR_EXPERIENCE');

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
    expect(tripResponse.statusCode, tripResponse.body).toBe(201);
    const { id: tripId, engagementId } = tripResponse.json<{
      data: { id: string; engagementId: string };
    }>().data;
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
      data: { tripCount: 1, engagements: [{ id: engagementId, trips: [{ id: tripId }] }] },
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
        url: `/api/v1/admin/engagements/${engagementId}/feedback-link`,
        headers: { cookie: adminCookie },
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/driver/engagements/${engagementId}/feedback-link`,
        headers: { cookie: driverCookie },
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/driver/engagements/${engagementId}/feedback-link`,
        headers: { cookie: otherCookie },
      }),
    ]);
    expect(adminFeedbackLink.statusCode, adminFeedbackLink.body).toBe(200);
    expect(driverFeedbackLink.statusCode, driverFeedbackLink.body).toBe(200);
    expect(otherDriverFeedbackLink.statusCode).toBe(404);
    const otherDriverPreparation = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/engagements/${engagementId}/start-feedback`,
      headers: { cookie: otherCookie },
    });
    expect(otherDriverPreparation.statusCode).toBe(404);
    const adminLinkData = adminFeedbackLink.json<{
      data: {
        engagementId: string;
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
        engagementId: adminLinkData.engagementId,
        feedbackLink: adminLinkData.feedbackLink,
        feedbackAccessTokenExpiresAt: adminLinkData.feedbackAccessTokenExpiresAt,
      },
    });
    expect(adminFeedbackLink.json()).not.toHaveProperty('data.feedbackAccessToken');
    expect(driverFeedbackLink.json()).not.toHaveProperty('data.feedbackAccessToken');

    const handoffPreparation = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/engagements/${engagementId}/start-feedback`,
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

    const startedFeedbackLink = await app.inject({
      method: 'GET',
      url: `/api/v1/driver/engagements/${engagementId}/feedback-link`,
      headers: { cookie: driverCookie },
    });
    expect(startedFeedbackLink.statusCode, startedFeedbackLink.body).toBe(200);
    expect(startedFeedbackLink.json()).toEqual({
      data: {
        engagementId: adminLinkData.engagementId,
        feedbackLink: adminLinkData.feedbackLink,
        feedbackAccessTokenExpiresAt: adminLinkData.feedbackAccessTokenExpiresAt,
      },
    });

    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/trips/${tripId}/archive`,
      headers: { cookie: adminCookie },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ data: { status: 'ARCHIVED' } });
    const revokedContext = await app.inject({
      method: 'GET',
      url: '/api/v1/passenger/feedback/context',
      headers: { authorization: `Bearer ${prepared.feedbackAccessToken}` },
    });
    expect(revokedContext.statusCode).toBe(401);
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

    const baseResponse = await create(base);
    expect(baseResponse.statusCode, baseResponse.body).toBe(201);

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
    const feedbackBooking = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bookings',
      headers: { cookie: adminCookie },
      payload: {
        bookingReference: `FEEDBACK-${suffix}`,
        passengerName: 'Feedback Passenger',
        passengerPhone: '+919876543214',
        startsAt: '2030-08-10T00:00:00.000Z',
        endsAt: '2030-08-11T00:00:00.000Z',
      },
    });
    expect(feedbackBooking.statusCode, feedbackBooking.body).toBe(201);
    const feedbackBookingId = feedbackBooking.json<{ data: { id: string } }>().data.id;
    extraBookingIds.push(feedbackBookingId);
    const payload = tripPayload(driverId);
    const selfCreated = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/trips',
      headers: { cookie: driverCookie },
      payload: {
        bookingId: feedbackBookingId,
        pickupLocation: payload.pickupLocation,
        destination: payload.destination,
        scheduledAt: payload.scheduledAt,
        scheduledEndAt: payload.scheduledEndAt,
        vehicleId: payload.vehicleId,
      },
    });
    expect(selfCreated.statusCode, selfCreated.body).toBe(201);
    const { id: selfTripId, engagementId: selfEngagementId } = selfCreated.json<{
      data: { id: string; engagementId: string };
    }>().data;
    expect(selfCreated.json()).toMatchObject({
      data: { creationSource: 'DRIVER_ENTERED', driver: { id: driverId } },
    });

    const concurrentStarts = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/driver/engagements/${selfEngagementId}/start-feedback`,
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

    const [preparedEngagement] = await database.db
      .select({
        status: bookingDriverEngagements.status,
        startedFeedbackAt: bookingDriverEngagements.startedFeedbackAt,
      })
      .from(bookingDriverEngagements)
      .where(eq(bookingDriverEngagements.id, selfEngagementId));
    expect(preparedEngagement).toEqual({ status: 'READY', startedFeedbackAt: null });

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
          schemaVersion: 2;
          sections: Array<{
            purpose: string;
            questionnaireVersionId: string;
            versionNumber: number;
            questions: { id: string; stableKey: string }[];
          }>;
        };
        consent: { id: string };
      };
    }>().data;
    expect(contextData.questionnaire.schemaVersion).toBe(2);
    expect(contextData.questionnaire.sections).toHaveLength(3);
    const driverSection = contextData.questionnaire.sections.find(
      (section) => section.purpose === 'DRIVER_FEEDBACK',
    )!;
    expect(driverSection).toMatchObject({
      purpose: 'DRIVER_FEEDBACK',
      questionnaireVersionId,
    });
    expect(driverSection.questions).toHaveLength(3);
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
    const [pinnedVersion] = await database.db
      .select({
        questionnaireVersionId: feedbackHandoffSections.questionnaireVersionId,
      })
      .from(feedbackHandoffSections)
      .innerJoin(feedbackHandoffs, eq(feedbackHandoffSections.handoffId, feedbackHandoffs.id))
      .where(
        and(
          eq(feedbackHandoffs.engagementId, selfEngagementId),
          eq(feedbackHandoffSections.purpose, 'DRIVER_FEEDBACK'),
        ),
      );
    expect(pinnedVersion).toEqual({ questionnaireVersionId });
    const questionId = (stableKey: string) =>
      driverSection.questions.find((question) => question.stableKey === stableKey)!.id;

    const clientSubmissionId = crypto.randomUUID();
    const submissionPayload = {
      clientSubmissionId,
      questionnaireSnapshot: contextData.questionnaire,
      respondent: {
        name: 'Passenger One',
        phone: '+919876543210',
        email: 'passenger@example.com',
        bookingReference: `FEEDBACK-${suffix}`,
        consentAccepted: true,
        consentedAt: '2026-08-10T06:30:00.000Z',
      },
      answers: contextData.questionnaire.sections.flatMap((section) =>
        section.purpose === 'DRIVER_FEEDBACK'
          ? [
              { questionId: questionId('overall_experience'), value: 5 },
              { questionId: questionId('recommend_driver'), value: true },
              { questionId: questionId('comments'), value: 'Excellent service' },
            ]
          : section.questions.map((question) => ({ questionId: question.id, value: 5 })),
      ),
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
      .where(eq(feedbackHandoffs.engagementId, selfEngagementId));
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
          data: { engagementId: string; status: string; startedFeedbackAt: string };
        }>().data,
    );
    expect(new Set(passengerStartData.map((result) => result.startedFeedbackAt)).size).toBe(1);
    expect(passengerStartData[0]).toMatchObject({
      engagementId: selfEngagementId,
      status: 'FEEDBACK_STARTED',
    });
    const [versionAfterStart] = await database.db
      .select({
        questionnaireVersionId: feedbackHandoffSections.questionnaireVersionId,
      })
      .from(feedbackHandoffSections)
      .innerJoin(feedbackHandoffs, eq(feedbackHandoffSections.handoffId, feedbackHandoffs.id))
      .where(
        and(
          eq(feedbackHandoffs.engagementId, selfEngagementId),
          eq(feedbackHandoffSections.purpose, 'DRIVER_FEEDBACK'),
        ),
      );
    expect(versionAfterStart).toEqual(pinnedVersion);

    const tampered = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/submissions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        ...submissionPayload,
        questionnaireSnapshot: {
          ...contextData.questionnaire,
          sections: [{ ...driverSection, versionNumber: 999 }],
        },
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
      .where(eq(feedbackHandoffs.engagementId, selfEngagementId));
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

    const duplicateEngagement = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/submissions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ...submissionPayload, clientSubmissionId: crypto.randomUUID() },
    });
    expect(duplicateEngagement.statusCode).toBe(409);
    expect(duplicateEngagement.json()).toMatchObject({
      error: { code: 'ENGAGEMENT_FEEDBACK_ALREADY_SUBMITTED' },
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

    const submittedEngagement = await database.db
      .select({ status: bookingDriverEngagements.status })
      .from(bookingDriverEngagements)
      .where(eq(bookingDriverEngagements.id, selfEngagementId))
      .limit(1);
    expect(submittedEngagement[0]?.status).toBe('SUBMITTED');

    const expiryBooking = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bookings',
      headers: { cookie: adminCookie },
      payload: {
        bookingReference: `EXPIRY-${suffix}`,
        passengerName: 'Expiry Passenger',
        passengerPhone: '+919876543212',
        startsAt: '2030-08-10T00:00:00.000Z',
        endsAt: '2030-08-11T00:00:00.000Z',
      },
    });
    expect(expiryBooking.statusCode, expiryBooking.body).toBe(201);
    const expiryBookingId = expiryBooking.json<{ data: { id: string } }>().data.id;
    extraBookingIds.push(expiryBookingId);
    const expiryTrip = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/trips',
      headers: { cookie: driverCookie },
      payload: {
        bookingId: expiryBookingId,
        pickupLocation: payload.pickupLocation,
        destination: payload.destination,
        scheduledAt: '2030-08-10T06:30:00.000Z',
        scheduledEndAt: '2030-08-10T07:30:00.000Z',
        vehicleId: payload.vehicleId,
      },
    });
    const expiryEngagementId = expiryTrip.json<{ data: { engagementId: string } }>().data
      .engagementId;
    const expiryStart = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/engagements/${expiryEngagementId}/start-feedback`,
      headers: { cookie: driverCookie },
    });
    const expiredToken = expiryStart.json<{ data: { feedbackAccessToken: string } }>().data
      .feedbackAccessToken;
    await database.db
      .update(feedbackHandoffs)
      .set({ expiresAt: new Date(0) })
      .where(eq(feedbackHandoffs.engagementId, expiryEngagementId));
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

  it('derives A-B-A engagements and freezes only the started schedule prefix', async () => {
    const adminCookie = await login('/api/v1/auth/admin/login', { email: adminEmail, password });
    const activateVehicle = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/vehicles/${vehicleId}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'ACTIVE' },
    });
    expect(activateVehicle.statusCode, activateVehicle.body).toBe(200);
    const createdBooking = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bookings',
      headers: { cookie: adminCookie },
      payload: {
        bookingReference: `ENG-${suffix}`,
        passengerName: 'Engagement Passenger',
        passengerPhone: '+919876543213',
        startsAt: '2031-09-01T00:00:00.000Z',
        endsAt: '2031-09-03T00:00:00.000Z',
      },
    });
    expect(createdBooking.statusCode, createdBooking.body).toBe(201);
    const engagementBookingId = createdBooking.json<{ data: { id: string } }>().data.id;
    extraBookingIds.push(engagementBookingId);

    const assignments = [
      { driverId, start: '2031-09-01T01:00:00.000Z' },
      { driverId, start: '2031-09-01T03:00:00.000Z' },
      { driverId: otherDriverId, start: '2031-09-01T05:00:00.000Z' },
      { driverId: otherDriverId, start: '2031-09-01T07:00:00.000Z' },
      { driverId, start: '2031-09-01T09:00:00.000Z' },
    ];
    const tripIds: string[] = [];
    for (const [index, assignment] of assignments.entries()) {
      const startsAt = new Date(assignment.start);
      const scheduledEndAt = new Date(startsAt.getTime() + 60 * 60 * 1000).toISOString();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/trips',
        headers: { cookie: adminCookie },
        payload: {
          bookingId: engagementBookingId,
          pickupLocation: `Stop ${index}`,
          destination: `Stop ${index + 1}`,
          scheduledAt: startsAt.toISOString(),
          scheduledEndAt,
          vehicleId,
          driverId: assignment.driverId,
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      tripIds.push(response.json<{ data: { id: string } }>().data.id);
    }

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bookings/${engagementBookingId}`,
      headers: { cookie: adminCookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const engagements = detail.json<{
      data: {
        engagements: Array<{
          id: string;
          sequenceNumber: number;
          driver: { id: string };
          feedbackPurposes: string[];
          trips: Array<{ id: string }>;
        }>;
      };
    }>().data.engagements;
    expect(
      engagements.map((engagement) => ({
        sequenceNumber: engagement.sequenceNumber,
        driverId: engagement.driver.id,
        purposes: engagement.feedbackPurposes,
        tripCount: engagement.trips.length,
      })),
    ).toEqual([
      {
        sequenceNumber: 1,
        driverId,
        purposes: ['ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK'],
        tripCount: 2,
      },
      { sequenceNumber: 2, driverId: otherDriverId, purposes: ['DRIVER_FEEDBACK'], tripCount: 2 },
      {
        sequenceNumber: 3,
        driverId,
        purposes: ['DRIVER_FEEDBACK', 'TOUR_EXPERIENCE'],
        tripCount: 1,
      },
    ]);

    const firstLink = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/engagements/${engagements[0]!.id}/feedback-link`,
      headers: { cookie: adminCookie },
    });
    expect(firstLink.statusCode, firstLink.body).toBe(200);
    const token = new URL(
      firstLink.json<{ data: { feedbackLink: string } }>().data.feedbackLink,
    ).searchParams.get('token')!;

    const duplicateArrival = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/engagements/${engagements[1]!.id}/feedback-sections`,
      headers: { cookie: adminCookie },
      payload: { feedbackPurposes: ['ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK'] },
    });
    expect(duplicateArrival.statusCode, duplicateArrival.body).toBe(409);
    expect(duplicateArrival.json()).toMatchObject({
      error: { code: 'BOOKING_FEEDBACK_PURPOSE_ALREADY_ASSIGNED' },
    });

    const sectionUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/engagements/${engagements[0]!.id}/feedback-sections`,
      headers: { cookie: adminCookie },
      payload: { feedbackPurposes: ['DRIVER_FEEDBACK'] },
    });
    expect(sectionUpdate.statusCode, sectionUpdate.body).toBe(200);
    expect(sectionUpdate.json()).toMatchObject({
      data: { status: 'READY', feedbackPurposes: ['DRIVER_FEEDBACK'] },
    });

    const revokedContext = await app.inject({
      method: 'GET',
      url: '/api/v1/passenger/feedback/context',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revokedContext.statusCode, revokedContext.body).toBe(401);
    expect(revokedContext.json()).toMatchObject({
      error: { code: 'FEEDBACK_HANDOFF_INVALID' },
    });

    const replacementLink = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/engagements/${engagements[0]!.id}/feedback-link`,
      headers: { cookie: adminCookie },
    });
    expect(replacementLink.statusCode, replacementLink.body).toBe(200);
    const replacementToken = new URL(
      replacementLink.json<{ data: { feedbackLink: string } }>().data.feedbackLink,
    ).searchParams.get('token')!;
    const replacementContext = await app.inject({
      method: 'GET',
      url: '/api/v1/passenger/feedback/context',
      headers: { authorization: `Bearer ${replacementToken}` },
    });
    expect(replacementContext.statusCode, replacementContext.body).toBe(200);
    expect(
      replacementContext
        .json<{ data: { questionnaire: { sections: Array<{ purpose: string }> } } }>()
        .data.questionnaire.sections.map(({ purpose }) => purpose),
    ).toEqual(['DRIVER_FEEDBACK']);

    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/start',
      headers: { authorization: `Bearer ${replacementToken}` },
    });
    expect(started.statusCode, started.body).toBe(200);

    const lockedSectionUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/engagements/${engagements[0]!.id}/feedback-sections`,
      headers: { cookie: adminCookie },
      payload: { feedbackPurposes: ['ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK'] },
    });
    expect(lockedSectionUpdate.statusCode, lockedSectionUpdate.body).toBe(409);
    expect(lockedSectionUpdate.json()).toMatchObject({
      error: { code: 'ENGAGEMENT_FEEDBACK_SECTIONS_NOT_EDITABLE' },
    });

    const lockedEdit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/trips/${tripIds[0]}`,
      headers: { cookie: adminCookie },
      payload: { destination: 'Cannot change frozen engagement' },
    });
    expect(lockedEdit.statusCode).toBe(409);
    expect(lockedEdit.json()).toMatchObject({
      error: { code: 'TRIP_ENGAGEMENT_LOCKED_BY_FEEDBACK' },
    });

    const appendFutureTrip = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trips',
      headers: { cookie: adminCookie },
      payload: {
        bookingId: engagementBookingId,
        pickupLocation: 'Final hotel',
        destination: 'Airport',
        scheduledAt: '2031-09-01T11:00:00.000Z',
        scheduledEndAt: '2031-09-01T12:00:00.000Z',
        vehicleId,
        driverId,
      },
    });
    expect(appendFutureTrip.statusCode, appendFutureTrip.body).toBe(201);
    const updatedDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bookings/${engagementBookingId}`,
      headers: { cookie: adminCookie },
    });
    expect(updatedDetail.statusCode, updatedDetail.body).toBe(200);
    const updatedEngagements = updatedDetail.json<{
      data: { engagements: Array<{ id: string; trips: unknown[] }> };
    }>().data.engagements;
    expect(updatedEngagements.map((engagement) => engagement.trips.length)).toEqual([2, 2, 2]);
    expect(updatedEngagements[0]!.id).toBe(engagements[0]!.id);
  }, 20_000);

  it.skip('legacy manual trip section assignment is replaced by derived engagements', async () => {
    const adminCookie = await login('/api/v1/auth/admin/login', { email: adminEmail, password });
    const activateVehicle = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/vehicles/${vehicleId}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'ACTIVE' },
    });
    expect(activateVehicle.statusCode, activateVehicle.body).toBe(200);

    const publishSection = async (
      purpose: 'ARRIVAL_EXPERIENCE' | 'TOUR_EXPERIENCE',
      category: 'ARRIVAL_EXPERIENCE' | 'TOUR_EXPERIENCE',
    ) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/questionnaires',
        headers: { cookie: adminCookie },
        payload: { name: `${purpose} ${suffix}`, purpose },
      });
      expect(created.statusCode, created.body).toBe(201);
      const result = created.json<{
        data: { questionnaire: { id: string }; draftVersionId: string };
      }>().data;
      extraQuestionnaireIds.push(result.questionnaire.id);
      const questions = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/questionnaires/${result.questionnaire.id}/versions/${result.draftVersionId}/questions`,
        headers: { cookie: adminCookie },
        payload: {
          questions: [
            {
              stableKey: `${purpose.toLowerCase()}_rating`,
              prompt: `Rate ${purpose.toLowerCase().replaceAll('_', ' ')}`,
              questionType: 'STAR_RATING',
              category,
              isRequired: true,
              contributesToScore: true,
              scoreMin: 1,
              scoreMax: 5,
              options: [],
            },
          ],
        },
      });
      expect(questions.statusCode, questions.body).toBe(200);
      const published = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/questionnaires/${result.questionnaire.id}/versions/${result.draftVersionId}/publish`,
        headers: { cookie: adminCookie },
      });
      expect(published.statusCode, published.body).toBe(200);
    };

    await publishSection('ARRIVAL_EXPERIENCE', 'ARRIVAL_EXPERIENCE');
    await publishSection('TOUR_EXPERIENCE', 'TOUR_EXPERIENCE');

    const firstTrip = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trips',
      headers: { cookie: adminCookie },
      payload: {
        bookingId,
        pickupLocation: 'Airport Terminal',
        destination: 'Arrival Hotel',
        scheduledAt: '2032-08-10T04:30:00.000Z',
        scheduledEndAt: '2032-08-10T05:30:00.000Z',
        vehicleId,
        driverId,
      },
    });
    expect(firstTrip.statusCode, firstTrip.body).toBe(201);
    const firstTripData = firstTrip.json<{
      data: { id: string; feedbackPurposes: string[] };
    }>().data;
    expect(firstTripData.feedbackPurposes).toEqual(['ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK']);

    const selectAll = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/trips/${firstTripData.id}`,
      headers: { cookie: adminCookie },
      payload: {
        feedbackPurposes: ['ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK', 'TOUR_EXPERIENCE'],
      },
    });
    expect(selectAll.statusCode, selectAll.body).toBe(200);

    const duplicateBoundary = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trips',
      headers: { cookie: adminCookie },
      payload: {
        bookingId,
        pickupLocation: 'Hotel',
        destination: 'Station',
        scheduledAt: '2032-08-11T04:30:00.000Z',
        scheduledEndAt: '2032-08-11T05:30:00.000Z',
        vehicleId,
        driverId,
        feedbackPurposes: ['ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK'],
      },
    });
    expect(duplicateBoundary.statusCode, duplicateBoundary.body).toBe(409);
    expect(duplicateBoundary.json()).toMatchObject({
      error: { code: 'BOOKING_FEEDBACK_PURPOSE_ALREADY_ASSIGNED' },
    });

    const link = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/trips/${firstTripData.id}/feedback-link`,
      headers: { cookie: adminCookie },
    });
    expect(link.statusCode, link.body).toBe(200);
    const token = new URL(
      link.json<{ data: { feedbackLink: string } }>().data.feedbackLink,
    ).searchParams.get('token')!;
    const context = await app.inject({
      method: 'GET',
      url: '/api/v1/passenger/feedback/context',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(context.statusCode, context.body).toBe(200);
    expect(
      context
        .json<{ data: { questionnaire: { sections: Array<{ purpose: string }> } } }>()
        .data.questionnaire.sections.map((section) => section.purpose),
    ).toEqual(['ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK', 'TOUR_EXPERIENCE']);

    const replaceSelections = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/trips/${firstTripData.id}`,
      headers: { cookie: adminCookie },
      payload: { feedbackPurposes: ['DRIVER_FEEDBACK'] },
    });
    expect(replaceSelections.statusCode, replaceSelections.body).toBe(200);
    const revokedContext = await app.inject({
      method: 'GET',
      url: '/api/v1/passenger/feedback/context',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revokedContext.statusCode).toBe(401);

    const completionWithoutTour = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/bookings/${bookingId}`,
      headers: { cookie: adminCookie },
      payload: { status: 'COMPLETED' },
    });
    expect(completionWithoutTour.statusCode, completionWithoutTour.body).toBe(409);
    expect(completionWithoutTour.json()).toMatchObject({
      error: { code: 'BOOKING_TOUR_FEEDBACK_MISSING' },
    });

    const restoreTour = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/trips/${firstTripData.id}`,
      headers: { cookie: adminCookie },
      payload: { feedbackPurposes: ['DRIVER_FEEDBACK', 'TOUR_EXPERIENCE'] },
    });
    expect(restoreTour.statusCode, restoreTour.body).toBe(200);

    const replacementLink = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/trips/${firstTripData.id}/feedback-link`,
      headers: { cookie: adminCookie },
    });
    expect(replacementLink.statusCode, replacementLink.body).toBe(200);
    const replacementToken = new URL(
      replacementLink.json<{ data: { feedbackLink: string } }>().data.feedbackLink,
    ).searchParams.get('token')!;
    const replacementContext = await app.inject({
      method: 'GET',
      url: '/api/v1/passenger/feedback/context',
      headers: { authorization: `Bearer ${replacementToken}` },
    });
    expect(replacementContext.statusCode, replacementContext.body).toBe(200);
    const replacementSnapshot = replacementContext.json<{
      data: {
        questionnaire: {
          schemaVersion: 2;
          sections: Array<{
            purpose: 'DRIVER_FEEDBACK' | 'TOUR_EXPERIENCE';
            questions: Array<{
              id: string;
              stableKey: string;
              questionType: 'STAR_RATING' | 'YES_NO' | 'TEXT';
            }>;
          }>;
        };
      };
    }>().data.questionnaire;
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/start',
      headers: { authorization: `Bearer ${replacementToken}` },
    });
    expect(started.statusCode, started.body).toBe(200);
    const compositeSubmission = await app.inject({
      method: 'POST',
      url: '/api/v1/passenger/feedback/submissions',
      headers: { authorization: `Bearer ${replacementToken}` },
      payload: {
        clientSubmissionId: crypto.randomUUID(),
        questionnaireSnapshot: replacementSnapshot,
        respondent: {
          name: 'Composite Passenger',
          phone: '+919876543211',
          email: 'composite@example.com',
          bookingReference: `BOOK-${suffix}`,
          consentAccepted: true,
          consentedAt: '2032-08-10T05:31:00.000Z',
        },
        answers: replacementSnapshot.sections.flatMap((section) =>
          section.questions.map((question) => ({
            questionId: question.id,
            value:
              question.questionType === 'TEXT'
                ? 'Composite response'
                : question.questionType === 'YES_NO'
                  ? true
                  : section.purpose === 'TOUR_EXPERIENCE'
                    ? 2
                    : 5,
          })),
        ),
        submittedAt: '2032-08-10T05:32:00.000Z',
        submissionMode: 'ONLINE',
      },
    });
    expect(compositeSubmission.statusCode, compositeSubmission.body).toBe(201);
    const compositeId = compositeSubmission.json<{ data: { id: string } }>().data.id;
    submissionIds.push(compositeId);

    const driverView = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/feedback/${compositeId}?view=DRIVER`,
      headers: { cookie: adminCookie },
    });
    expect(driverView.statusCode, driverView.body).toBe(200);
    expect(
      driverView.json<{ data: { overallScore: number; answers: Array<{ purpose: string }> } }>()
        .data,
    ).toMatchObject({
      overallScore: 5,
      answers: [
        { purpose: 'DRIVER_FEEDBACK' },
        { purpose: 'DRIVER_FEEDBACK' },
        { purpose: 'DRIVER_FEEDBACK' },
      ],
    });
    const companyView = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/feedback/${compositeId}?view=COMPANY`,
      headers: { cookie: adminCookie },
    });
    expect(companyView.statusCode, companyView.body).toBe(200);
    expect(companyView.json()).toMatchObject({
      data: {
        overallScore: 2,
        answers: [{ purpose: 'TOUR_EXPERIENCE' }],
      },
    });
    const companyList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/feedback?view=COMPANY',
      headers: { cookie: adminCookie },
    });
    expect(companyList.statusCode, companyList.body).toBe(200);
    const companyListData = companyList.json<{
      data: Array<{ id: string; overallScore: number | null }>;
    }>().data;
    expect(companyListData.find((item) => item.id === compositeId)).toMatchObject({
      id: compositeId,
      overallScore: 2,
    });

    const completedBooking = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/bookings/${bookingId}`,
      headers: { cookie: adminCookie },
      payload: { status: 'COMPLETED' },
    });
    expect(completedBooking.statusCode, completedBooking.body).toBe(200);
    expect(completedBooking.json()).toMatchObject({ data: { status: 'COMPLETED' } });
  }, 20_000);

  async function login(url: string, payload: Record<string, string>): Promise<string> {
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return cookie!.split(';', 1)[0]!;
  }

  async function publishBoundaryQuestionnaire(
    adminCookie: string,
    purpose: 'ARRIVAL_EXPERIENCE' | 'TOUR_EXPERIENCE',
    category: 'ARRIVAL_EXPERIENCE' | 'TOUR_EXPERIENCE',
  ) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/questionnaires',
      headers: { cookie: adminCookie },
      payload: { name: `${purpose} base ${suffix}`, purpose },
    });
    expect(created.statusCode, created.body).toBe(201);
    const result = created.json<{
      data: { questionnaire: { id: string }; draftVersionId: string };
    }>().data;
    extraQuestionnaireIds.push(result.questionnaire.id);
    const questions = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/questionnaires/${result.questionnaire.id}/versions/${result.draftVersionId}/questions`,
      headers: { cookie: adminCookie },
      payload: {
        questions: [
          {
            stableKey: `${purpose.toLowerCase()}_base_rating`,
            prompt: `Rate ${purpose.toLowerCase().replaceAll('_', ' ')}`,
            questionType: 'STAR_RATING',
            category,
            isRequired: true,
            contributesToScore: true,
            scoreMin: 1,
            scoreMax: 5,
            options: [],
          },
        ],
      },
    });
    expect(questions.statusCode, questions.body).toBe(200);
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/questionnaires/${result.questionnaire.id}/versions/${result.draftVersionId}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(published.statusCode, published.body).toBe(200);
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
