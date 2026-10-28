import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
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
  consentVersions,
  questionnaires,
  questionnaireVersions,
  feedbackHandoffs,
  feedbackSubmissions,
  feedbackSubmissionSections,
  feedbackAnswers,
  feedbackPhotos,
  feedbackReviewEvents,
} from '../src/database/schema/index.js';
import {
  FeedbackService,
  type SubmitFeedbackInput,
} from '../src/modules/feedback/feedback.service.js';
import { passwordHasher } from '../src/modules/auth/password.js';
import { createFieldEncryptor } from '../src/shared/security/field-encryption.js';
import type { PhotoStorage } from '../src/shared/storage/photo-storage.js';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Snapshot = { sections: { questions: { id: string }[] }[] };
type Link = {
  feedbackLink: string;
  feedbackAccessTokenExpiresAt: string;
  allowMultipleSubmissions: boolean;
};
const passenger = '/api/v1/passenger/feedback';

integration('group passenger feedback', () => {
  let database: DatabaseClient, app: FastifyInstance, services: ApplicationServices;
  let adminId: string, driverId: string, otherDriverId: string, vehicleId: string;
  let adminCookie: string, driverCookie: string, otherCookie: string;
  let questionnaireId: string, consentId: string;
  let bookingId: string, bookingReference: string, engagementId: string, otherEngagementId: string;
  let clock = new Date(),
    fixture = 0;
  const suffix = randomUUID(),
    accountIds: string[] = [],
    bookingIds: string[] = [],
    engagementIds: string[] = [];
  const password = 'group-feedback-test-password';
  const storage: PhotoStorage = {
    enabled: true,
    maxUploadBytes: 1000000,
    uploadUrlTtlSeconds: 600,
    downloadUrlTtlSeconds: 300,
    orphanTtlHours: 24,
    buildUploadObjectKey: (engagement, id) => `group/pending/${engagement}/${id}`,
    buildStoredObjectKey: (engagement, id) => `group/stored/${engagement}/${id}`,
    createUploadUrl: async (key) => `https://storage.example/upload/${key}`,
    sanitize: async () => ({ contentType: 'image/jpeg', byteSize: 100 }),
    createDownloadUrl: async (key) => `https://storage.example/download/${key}`,
    delete: async () => {},
  };
  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL });
    database = createDatabaseClient(config);
    const hash = await passwordHasher.hash(password);
    for (const role of ['ADMIN', 'DRIVER', 'DRIVER'] as const) {
      const [account] = await database.db
        .insert(authAccounts)
        .values({
          role,
          displayName: `Group ${role}`,
          email: `${accountIds.length}-${suffix}@example.com`,
          passwordHash: hash,
        })
        .returning();
      accountIds.push(account!.id);
    }
    adminId = accountIds[0]!;
    const ds = await database.db
      .insert(drivers)
      .values([
        { accountId: accountIds[1]!, driverCode: `G-${suffix}`, sourceType: 'AGENCY' },
        { accountId: accountIds[2]!, driverCode: `O-${suffix}`, sourceType: 'AGENCY' },
      ])
      .returning();
    driverId = ds[0]!.id;
    otherDriverId = ds[1]!.id;
    const [vehicle] = await database.db
      .insert(vehicles)
      .values({
        registrationNumber: `G-${suffix}`,
        displayName: 'Group vehicle',
        vehicleType: 'CAR',
      })
      .returning();
    vehicleId = vehicle!.id;
    services = createApplicationServices(database.db, config);
    services = {
      ...services,
      feedbackService: new FeedbackService(
        database.db,
        services.questionnaireService,
        services.settingsService,
        createFieldEncryptor(config.dataEncryptionKey),
        config.feedbackHandoffTtlHours,
        config.passengerFeedbackUrl,
        storage,
        () => clock,
      ),
    };
    app = await buildApp({ exposeDocs: false, services });
    const login = async (url: string, payload: object) => {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode, response.body).toBe(200);
      return String(response.headers['set-cookie']).split(';')[0]!;
    };
    adminCookie = await login('/api/v1/auth/admin/login', {
      email: `0-${suffix}@example.com`,
      password,
    });
    driverCookie = await login('/api/v1/auth/driver/login', {
      driverCode: `G-${suffix}`,
      password,
    });
    otherCookie = await login('/api/v1/auth/driver/login', { driverCode: `O-${suffix}`, password });
    const q = await services.questionnaireService.create(
      `Group ${suffix}`,
      'DRIVER_FEEDBACK',
      adminId,
    );
    questionnaireId = q.questionnaire.id;
    await services.questionnaireService.replaceQuestions(
      questionnaireId,
      q.version.id,
      [
        {
          stableKey: 'overall',
          prompt: 'How was your driver?',
          questionType: 'STAR_RATING',
          category: 'OVERALL_EXPERIENCE',
          isRequired: true,
          contributesToScore: true,
          scoreMin: 1,
          scoreMax: 5,
          options: [],
        },
      ],
      adminId,
    );
    await services.questionnaireService.publish(questionnaireId, q.version.id, adminId);
    consentId = (
      await services.questionnaireService.createConsent('I agree to give feedback.', adminId)
    ).id;
  });
  beforeEach(async () => {
    clock = new Date();
    fixture++;
    bookingReference = `GROUP-${suffix}-${fixture}`;
    const [booking] = await database.db
      .insert(bookings)
      .values({
        bookingReference,
        passengerName: 'Group organiser',
        startsAt: new Date(clock.getTime() - 3600000),
        endsAt: new Date(clock.getTime() + 86400000 * 60),
        createdByAccountId: adminId,
      })
      .returning();
    bookingId = booking!.id;
    bookingIds.push(bookingId);
    const start = new Date(clock.getTime() + fixture * 86400000);
    for (const [index, id] of [driverId, otherDriverId].entries()) {
      await services.tripService.createAdmin(
        {
          bookingId,
          driverId: id,
          vehicleId,
          pickupLocation: 'Airport',
          destination: 'Hotel',
          scheduledAt: new Date(start.getTime() + index * 7200000).toISOString(),
          scheduledEndAt: new Date(start.getTime() + index * 7200000 + 3600000).toISOString(),
        },
        adminId,
      );
    }
    const es = (await services.engagementService.list({ bookingId, page: 1, pageSize: 100 })).items;
    engagementId = es.find((e) => e.driverId === driverId)!.id;
    otherEngagementId = es.find((e) => e.driverId === otherDriverId)!.id;
    engagementIds.push(...es.map((e) => e.id));
    for (const e of es)
      await services.engagementService.updateFeedbackSections(e.id, ['DRIVER_FEEDBACK'], adminId);
  });
  afterAll(async () => {
    await app?.close();
    if (!database) return;
    if (engagementIds.length) {
      const rows = await database.db
        .select({ id: feedbackSubmissions.id })
        .from(feedbackSubmissions)
        .where(inArray(feedbackSubmissions.engagementId, engagementIds));
      const ids = rows.map((r) => r.id);
      await database.db
        .delete(feedbackPhotos)
        .where(inArray(feedbackPhotos.engagementId, engagementIds));
      if (ids.length) {
        await database.db
          .delete(feedbackReviewEvents)
          .where(inArray(feedbackReviewEvents.feedbackSubmissionId, ids));
        await database.db
          .delete(feedbackAnswers)
          .where(inArray(feedbackAnswers.feedbackSubmissionId, ids));
        await database.db
          .delete(feedbackSubmissionSections)
          .where(inArray(feedbackSubmissionSections.feedbackSubmissionId, ids));
        await database.db.delete(feedbackSubmissions).where(inArray(feedbackSubmissions.id, ids));
      }
      await database.db.delete(trips).where(inArray(trips.bookingId, bookingIds));
      await database.db
        .delete(bookingDriverEngagements)
        .where(inArray(bookingDriverEngagements.bookingId, bookingIds));
      await database.db.delete(bookings).where(inArray(bookings.id, bookingIds));
    }
    if (questionnaireId) {
      await database.db
        .delete(questionnaireVersions)
        .where(eq(questionnaireVersions.questionnaireId, questionnaireId));
      await database.db.delete(questionnaires).where(eq(questionnaires.id, questionnaireId));
    }
    if (consentId)
      await database.db.delete(consentVersions).where(eq(consentVersions.id, consentId));
    await database.db.delete(auditEvents).where(inArray(auditEvents.actorAccountId, accountIds));
    await database.db.delete(drivers).where(inArray(drivers.accountId, accountIds));
    await database.db.delete(authAccounts).where(inArray(authAccounts.id, accountIds));
    if (vehicleId) await database.db.delete(vehicles).where(eq(vehicles.id, vehicleId));
    await database.close();
  });
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const tokenOf = (link: Link) => new URL(link.feedbackLink).searchParams.get('token')!;
  const generate = async (
    id = engagementId,
    body: object = { allowMultipleSubmissions: true },
    cookie = adminCookie,
    role = 'admin',
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/${role}/engagements/${id}/feedback-link`,
      headers: { cookie },
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ data: Link }>().data;
  };
  const prepare = async (id = engagementId, multiple = true) => {
    const link = await generate(id, { allowMultipleSubmissions: multiple });
    const token = tokenOf(link);
    const context = await app.inject({ url: `${passenger}/context`, headers: headers(token) });
    expect(context.statusCode, context.body).toBe(200);
    expect(
      context.json<{ data: { allowMultipleSubmissions: boolean } }>().data.allowMultipleSubmissions,
    ).toBe(multiple);
    const snapshot = context.json<{ data: { questionnaire: Snapshot } }>().data.questionnaire;
    expect(
      (await app.inject({ method: 'POST', url: `${passenger}/start`, headers: headers(token) }))
        .statusCode,
    ).toBe(200);
    return { token, link, snapshot };
  };
  const payload = (snapshot: Snapshot, phone = '+919876543210'): SubmitFeedbackInput => ({
    clientSubmissionId: randomUUID(),
    questionnaireSnapshot: snapshot,
    respondent: {
      name: 'Traveller',
      phone,
      email: 'traveller@example.com',
      bookingReference,
      consentAccepted: true,
      consentedAt: clock.toISOString(),
    },
    answers: snapshot.sections.flatMap((s) =>
      s.questions.map((q) => ({ questionId: q.id, value: 5 })),
    ),
    submittedAt: clock.toISOString(),
    submissionMode: 'ONLINE',
  });
  const submit = (token: string, body: SubmitFeedbackInput) =>
    app.inject({
      method: 'POST',
      url: `${passenger}/submissions`,
      headers: headers(token),
      payload: body,
    });

  it('keeps the shared link usable for multiple travellers and counts each response in reports', async () => {
    const { token, snapshot, link } = await prepare();
    const [before] = await database.db
      .select()
      .from(feedbackHandoffs)
      .where(eq(feedbackHandoffs.engagementId, engagementId));
    for (const phone of ['+919876543210', '+919876543211']) {
      const upload = await app.inject({
        method: 'POST',
        url: `${passenger}/photo-uploads`,
        headers: headers(token),
        payload: { contentType: 'image/jpeg', sizeBytes: 100 },
      });
      expect(upload.statusCode, upload.body).toBe(201);
      const photoId = upload.json<{ data: { id: string } }>().data.id;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${passenger}/photo-uploads/${photoId}/complete`,
            headers: headers(token),
          })
        ).statusCode,
      ).toBe(200);
      expect((await submit(token, { ...payload(snapshot, phone), photoId })).statusCode).toBe(201);
      expect(
        (await app.inject({ url: `${passenger}/context`, headers: headers(token) })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: `${passenger}/start`, headers: headers(token) }))
          .statusCode,
      ).toBe(200);
    }
    const [after] = await database.db
      .select()
      .from(feedbackHandoffs)
      .where(eq(feedbackHandoffs.engagementId, engagementId));
    expect(after).toEqual(before);
    expect(await generate(engagementId, {})).toMatchObject(link);
    expect((await services.engagementService.get(engagementId)).status).toBe('FEEDBACK_STARTED');
    const rows = await database.db
      .select()
      .from(feedbackSubmissions)
      .where(eq(feedbackSubmissions.engagementId, engagementId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.respondentPhoneHash?.length === 64)).toBe(true);
    const analytics = await services.analyticsService.getDriverPerformance(driverId);
    expect(analytics.overall.responseCount).toBe(2);
    const listed = await services.adminFeedbackService.list({
      page: 1,
      pageSize: 100,
      view: 'DRIVER',
      driverId,
    });
    expect(listed.items.filter((r) => r.engagementId === engagementId)).toHaveLength(2);
    const photos = await database.db
      .select()
      .from(feedbackPhotos)
      .where(eq(feedbackPhotos.engagementId, engagementId));
    expect(new Set(photos.map((p) => p.feedbackSubmissionId)).size).toBe(2);
    const reusedPhoto = await submit(token, {
      ...payload(snapshot, '+919876543212'),
      photoId: photos[0]!.id,
    });
    expect(reusedPhoto.statusCode).toBe(409);
    expect(reusedPhoto.json()).toMatchObject({ error: { code: 'PHOTO_NOT_READY' } });
    const locked = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/engagements/${engagementId}/feedback-link`,
      headers: { cookie: adminCookie },
      payload: { allowMultipleSubmissions: false },
    });
    expect(locked.statusCode).toBe(409);
  });
  it('deduplicates formatted phones, handles concurrent retries, and rejects reused client IDs for another traveller', async () => {
    const { token, snapshot } = await prepare();
    const body = payload(snapshot, '0091 (98765) 43210');
    expect(
      (await Promise.all([submit(token, body), submit(token, body)]))
        .map((r) => r.statusCode)
        .sort(),
    ).toEqual([200, 201]);
    const duplicate = await submit(token, payload(snapshot, '+91 98765-43210'));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: 'RESPONDENT_FEEDBACK_ALREADY_SUBMITTED' },
    });
    expect(
      (await submit(token, { ...body, respondent: { ...body.respondent, phone: '+919876543211' } }))
        .statusCode,
    ).toBe(409);
    const other = payload(snapshot, '+919876543212');
    const race = await Promise.all([
      submit(token, other),
      submit(token, { ...other, clientSubmissionId: randomUUID() }),
    ]);
    expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await submit(token, payload(snapshot, '9876543210'))).statusCode).toBe(400);
    const rows = await database.db
      .select()
      .from(feedbackSubmissions)
      .where(eq(feedbackSubmissions.engagementId, engagementId));
    expect(rows).toHaveLength(2);
    await services.adminFeedbackService.updateReviewState(
      rows[0]!.id,
      'ARCHIVED',
      'Test review',
      adminId,
    );
    expect((await submit(token, payload(snapshot))).statusCode).toBe(409);
    const encryptor = createFieldEncryptor(
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL })
        .dataEncryptionKey,
    );
    expect(encryptor.decrypt(rows[0]!.respondentPhoneCiphertext)).toBe('+919876543210');
    await expect(
      database.db
        .insert(feedbackSubmissions)
        .values({ ...rows[0]!, id: randomUUID(), clientSubmissionId: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
  it('allows the same phone for another engagement in the same booking', async () => {
    const first = await prepare(),
      second = await prepare(otherEngagementId);
    const body = payload(first.snapshot);
    expect((await submit(first.token, body)).statusCode).toBe(201);
    expect(
      (
        await submit(second.token, {
          ...payload(second.snapshot),
          clientSubmissionId: body.clientSubmissionId,
        })
      ).statusCode,
    ).toBe(409);
    expect((await submit(second.token, payload(second.snapshot))).statusCode).toBe(201);
    const rows = await database.db
      .select()
      .from(feedbackSubmissions)
      .where(inArray(feedbackSubmissions.engagementId, [engagementId, otherEngagementId]));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.respondentPhoneHash).not.toBe(rows[1]!.respondentPhoneHash);
  });
  it('defaults to single response and cannot convert a started or completed link to group mode', async () => {
    const generated = await generate(engagementId, {});
    expect(generated.allowMultipleSubmissions).toBe(false);
    const { token, snapshot } = await prepare(engagementId, false);
    const locked = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/engagements/${engagementId}/feedback-link`,
      headers: { cookie: adminCookie },
      payload: { allowMultipleSubmissions: true },
    });
    expect(locked.statusCode).toBe(409);
    const body = payload(snapshot);
    expect((await submit(token, body)).statusCode).toBe(201);
    await database.db
      .update(feedbackSubmissions)
      .set({ respondentPhoneHash: null })
      .where(eq(feedbackSubmissions.clientSubmissionId, body.clientSubmissionId));
    expect((await submit(token, body)).statusCode).toBe(200);
    const duplicate = await submit(token, payload(snapshot, '+919876543211'));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: 'ENGAGEMENT_FEEDBACK_ALREADY_SUBMITTED' },
    });
    expect(
      (await app.inject({ url: `${passenger}/context`, headers: headers(token) })).statusCode,
    ).toBe(401);
    expect((await services.engagementService.get(engagementId)).status).toBe('SUBMITTED');
    await expect(
      services.feedbackService.issueHandoff(engagementId, { allowMultipleSubmissions: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('preserves deduplication and pinned questions when an expired group link is renewed', async () => {
    const { token, snapshot, link } = await prepare();
    const body = payload(snapshot);
    expect((await submit(token, body)).statusCode).toBe(201);
    const draft = await services.questionnaireService.createDraft(questionnaireId, adminId);
    await services.questionnaireService.replaceQuestions(
      questionnaireId,
      draft.id,
      [
        {
          stableKey: 'new_overall',
          prompt: 'New published question',
          questionType: 'STAR_RATING',
          category: 'OVERALL_EXPERIENCE',
          isRequired: true,
          contributesToScore: true,
          scoreMin: 1,
          scoreMax: 5,
          options: [],
        },
      ],
      adminId,
    );
    await services.questionnaireService.publish(questionnaireId, draft.id, adminId);
    clock = new Date(new Date(link.feedbackAccessTokenExpiresAt).getTime() + 1000);
    expect((await submit(token, payload(snapshot, '+919876543211'))).statusCode).toBe(401);
    expect(
      (await app.inject({ url: `${passenger}/context`, headers: headers(token) })).statusCode,
    ).toBe(401);
    const renewed = await generate(engagementId, {});
    const newToken = tokenOf(renewed);
    expect(newToken).not.toBe(token);
    expect((await submit(token, payload(snapshot, '+919876543211'))).statusCode).toBe(401);
    const duplicate = await submit(newToken, payload(snapshot));
    expect(duplicate.json()).toMatchObject({
      error: { code: 'RESPONDENT_FEEDBACK_ALREADY_SUBMITTED' },
    });
    const context = await app.inject({ url: `${passenger}/context`, headers: headers(newToken) });
    expect(context.json<{ data: { questionnaire: Snapshot } }>().data.questionnaire).toEqual(
      snapshot,
    );
    expect((await submit(newToken, payload(snapshot, '+919876543211'))).statusCode).toBe(201);
  });
  it('lets only admins close group collection, without deleting responses or reviving the link', async () => {
    const { token, snapshot } = await prepare();
    expect((await submit(token, payload(snapshot))).statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/engagements/${engagementId}/close-feedback`,
          headers: { cookie: driverCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/engagements/${engagementId}/close-feedback`,
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(204);
    expect((await services.engagementService.get(engagementId)).status).toBe('SUBMITTED');
    expect((await submit(token, payload(snapshot, '+919876543211'))).statusCode).toBe(401);
    expect(
      (await app.inject({ url: `${passenger}/context`, headers: headers(token) })).statusCode,
    ).toBe(401);
    await expect(services.feedbackService.issueHandoff(engagementId)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(
      await database.db
        .select()
        .from(feedbackSubmissions)
        .where(eq(feedbackSubmissions.engagementId, engagementId)),
    ).toHaveLength(1);
  });
  it('allows mode selection before starting, preserves URL/expiry, and enforces driver ownership', async () => {
    const single = await generate(engagementId, {});
    const group = await generate(
      engagementId,
      { allowMultipleSubmissions: true },
      driverCookie,
      'driver',
    );
    expect(group).toMatchObject({
      feedbackLink: single.feedbackLink,
      feedbackAccessTokenExpiresAt: single.feedbackAccessTokenExpiresAt,
      allowMultipleSubmissions: true,
    });
    const existing = await app.inject({
      url: `/api/v1/driver/engagements/${engagementId}/feedback-link`,
      headers: { cookie: driverCookie },
    });
    expect(existing.json()).toMatchObject({ data: { allowMultipleSubmissions: true } });
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/engagements/${engagementId}/feedback-link`,
      headers: { cookie: otherCookie },
      payload: { allowMultipleSubmissions: true },
    });
    expect(denied.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/engagements/${engagementId}/feedback-link`,
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });
});
