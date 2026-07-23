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
  drivers,
  consentVersions,
  feedbackAnswers,
  feedbackHandoffs,
  feedbackSubmissions,
  questionnaireVersions,
  questionnaires,
  trips,
  vehicles,
} from '../src/database/schema/index.js';
import { passwordHasher } from '../src/modules/auth/password.js';

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
      SESSION_TTL_HOURS: '12',
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
    if (vehicleId) await database.db.delete(vehicles).where(inArray(vehicles.id, [vehicleId]));
    await database.close();
  });

  it('manages vehicles and the admin-assigned trip lifecycle', async () => {
    const adminCookie = await login('/api/v1/auth/admin/login', { email: adminEmail, password });
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
        creationSource: 'ADMIN_ASSIGNED',
        status: 'READY',
        vehicle: { displayName: 'Updated Crysta' },
        driver: { id: driverId, sourceType: 'AGENCY' },
      },
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

    const start = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/trips/${tripId}/start-feedback`,
      headers: { cookie: driverCookie },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ data: { status: 'FEEDBACK_STARTED' } });

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
  }, 20_000);

  it('submits driver-entered trip feedback idempotently and rejects inactive vehicles', async () => {
    const adminCookie = await login('/api/v1/auth/admin/login', { email: adminEmail, password });
    const driverCookie = await login('/api/v1/auth/driver/login', { driverCode, password });
    const payload = tripPayload(driverId);
    const selfCreated = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/trips',
      headers: { cookie: driverCookie },
      payload: {
        bookingReference: `${payload.bookingReference}-SELF`,
        passengerName: payload.passengerName,
        pickupLocation: payload.pickupLocation,
        destination: payload.destination,
        scheduledAt: payload.scheduledAt,
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

    const context = await app.inject({
      method: 'GET',
      url: '/api/v1/passenger/feedback/context',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(context.statusCode).toBe(200);
    const contextData = context.json<{
      data: {
        questionnaire: {
          questionnaireVersionId: string;
          questions: { id: string; stableKey: string }[];
        };
      };
    }>().data;
    expect(contextData.questionnaire.questionnaireVersionId).toBe(questionnaireVersionId);
    expect(contextData.questionnaire.questions).toHaveLength(3);
    const questionId = (stableKey: string) =>
      contextData.questionnaire.questions.find((question) => question.stableKey === stableKey)!.id;

    const clientSubmissionId = crypto.randomUUID();
    const submissionPayload = {
      clientSubmissionId,
      questionnaireVersionId,
      questionnaireSnapshot: contextData.questionnaire,
      respondent: {
        name: 'Passenger One',
        phone: '+91-9876543210',
        email: 'passenger@example.com',
        bookingReference: `${payload.bookingReference}-SELF`,
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
        bookingReference: `${payload.bookingReference}-EXPIRY`,
        passengerName: payload.passengerName,
        pickupLocation: payload.pickupLocation,
        destination: payload.destination,
        scheduledAt: payload.scheduledAt,
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
      bookingReference: `BOOK-${suffix}`,
      passengerName: 'Integration Passenger',
      pickupLocation: 'Kolkata Airport',
      destination: 'Darjeeling',
      scheduledAt: '2026-08-10T04:30:00.000Z',
      vehicleId,
      driverId: assignedDriverId,
    };
  }
});
