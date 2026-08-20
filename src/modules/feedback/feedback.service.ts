import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  feedbackAnswers,
  feedbackHandoffs,
  feedbackHandoffSections,
  feedbackPhotos,
  feedbackSubmissions,
  feedbackSubmissionSections,
  bookings,
  tripFeedbackSections,
  trips,
} from '../../database/schema/index.js';
import { isPostgresError } from '../../shared/database/postgres-error.js';
import type { FieldEncryptor } from '../../shared/security/field-encryption.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  InvalidStoredPhotoError,
  type AcceptedPhotoContentType,
  type PhotoStorage,
} from '../../shared/storage/photo-storage.js';
import type { QuestionnaireService } from '../questionnaires/questionnaire.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { validateFeedbackAnswers } from './answer.validator.js';
import {
  buildCompositeQuestionnaireSnapshot,
  buildQuestionnaireSnapshot,
  flattenCompositeQuestions,
  type FeedbackQuestionnaireSection,
} from './questionnaire-snapshot.js';

export interface SubmitFeedbackInput {
  readonly clientSubmissionId: string;
  readonly questionnaireSnapshot: unknown;
  readonly respondent: {
    readonly name: string;
    readonly phone: string;
    readonly email: string;
    readonly bookingReference: string;
    readonly consentAccepted: true;
    readonly consentedAt: string;
  };
  readonly answers: readonly { readonly questionId: string; readonly value: unknown }[];
  readonly submittedAt: string;
  readonly submissionMode: 'ONLINE' | 'OFFLINE_SYNC';
  readonly photoId?: string;
}

export class FeedbackService {
  constructor(
    private readonly db: AppDatabase,
    private readonly questionnaires: QuestionnaireService,
    private readonly settings: SettingsService,
    private readonly encryptor: FieldEncryptor,
    private readonly handoffTtlHours: number,
    private readonly passengerFeedbackUrl: string,
    private readonly photoStorage: PhotoStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issueHandoff(tripId: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tripId}, 0))`);

      const [existingSubmission] = await tx
        .select({ id: feedbackSubmissions.id })
        .from(feedbackSubmissions)
        .where(eq(feedbackSubmissions.tripId, tripId))
        .limit(1);
      const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).limit(1);
      if (existingSubmission || (trip?.status !== 'READY' && trip?.status !== 'FEEDBACK_STARTED')) {
        throw new AppError({
          code: 'FEEDBACK_HANDOFF_UNAVAILABLE',
          message: 'Passenger feedback is unavailable for this trip',
          statusCode: 409,
        });
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${'booking:' + trip.bookingId}, 0))`,
      );

      const [existingHandoff] = await tx
        .select()
        .from(feedbackHandoffs)
        .where(eq(feedbackHandoffs.tripId, tripId))
        .limit(1);
      const now = this.now();
      if (existingHandoff && !existingHandoff.consumedAt && existingHandoff.expiresAt > now) {
        const token = this.encryptor.decrypt(existingHandoff.tokenCiphertext);
        return {
          tripId,
          token,
          expiresAt: existingHandoff.expiresAt,
          link: this.buildHandoffLink(token),
        };
      }

      const assignedSections = await tx
        .select({ purpose: tripFeedbackSections.purpose })
        .from(tripFeedbackSections)
        .where(eq(tripFeedbackSections.tripId, tripId))
        .orderBy(sectionOrderSql(tripFeedbackSections.purpose));
      if (!assignedSections.length) {
        throw new AppError({
          code: 'TRIP_FEEDBACK_SECTIONS_REQUIRED',
          message: 'Select at least one feedback section before sharing feedback',
          statusCode: 409,
        });
      }
      const [versions, consent] = await Promise.all([
        Promise.all(
          assignedSections.map(({ purpose }) => this.questionnaires.getActiveVersion(purpose)),
        ),
        this.questionnaires.getActiveConsent(),
      ]);
      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const tokenCiphertext = this.encryptor.encrypt(token);
      const expiresAt = new Date(now.getTime() + this.handoffTtlHours * 60 * 60 * 1000);

      let handoffId: string;
      if (existingHandoff) {
        handoffId = existingHandoff.id;
        await tx
          .update(feedbackHandoffs)
          .set({
            questionnaireVersionId: null,
            consentVersionId: consent.id,
            tokenHash,
            tokenCiphertext,
            expiresAt,
            consumedAt: null,
          })
          .where(eq(feedbackHandoffs.id, existingHandoff.id));
        await tx
          .delete(feedbackHandoffSections)
          .where(eq(feedbackHandoffSections.handoffId, existingHandoff.id));
      } else {
        const [createdHandoff] = await tx
          .insert(feedbackHandoffs)
          .values({
            tripId,
            questionnaireVersionId: null,
            consentVersionId: consent.id,
            tokenHash,
            tokenCiphertext,
            expiresAt,
          })
          .returning({ id: feedbackHandoffs.id });
        if (!createdHandoff) throw new Error('Feedback handoff insert did not return a row');
        handoffId = createdHandoff.id;
      }

      await tx.insert(feedbackHandoffSections).values(
        versions.map((version, displayOrder) => ({
          handoffId,
          purpose: assignedSections[displayOrder]!.purpose,
          questionnaireVersionId: version.id,
          displayOrder,
        })),
      );

      return { tripId, token, expiresAt, link: this.buildHandoffLink(token) };
    });
  }

  async getContext(token: string) {
    const handoff = await this.resolveHandoff(token, true);
    const [trip, questionnaireSections, settings] = await Promise.all([
      this.getTrip(handoff.tripId),
      this.loadQuestionnaireSections(handoff),
      this.settings.get(),
    ]);
    const consent = await this.questionnaires.getConsentById(handoff.consentVersionId);
    if (trip.status !== 'READY' && trip.status !== 'FEEDBACK_STARTED') this.invalidHandoff();
    return {
      trip,
      questionnaireSections,
      consent,
      settings,
      snapshot: buildCompositeQuestionnaireSnapshot(questionnaireSections),
    };
  }

  async start(token: string) {
    if (!token) this.invalidHandoff();
    const tokenHash = hashToken(token);
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(feedbackHandoffs)
        .where(eq(feedbackHandoffs.tokenHash, tokenHash))
        .limit(1);
      if (!candidate) this.invalidHandoff();

      // Share the trip-scoped lock used by handoff issuance so token replacement
      // and concurrent passenger starts cannot observe each other halfway through.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${candidate.tripId}, 0))`);
      const [handoff] = await tx
        .select()
        .from(feedbackHandoffs)
        .where(eq(feedbackHandoffs.tokenHash, tokenHash))
        .limit(1);
      if (!handoff || handoff.consumedAt || handoff.expiresAt <= this.now()) {
        this.invalidHandoff();
      }

      const [trip] = await tx
        .select({
          id: trips.id,
          status: trips.status,
          startedFeedbackAt: trips.startedFeedbackAt,
        })
        .from(trips)
        .where(eq(trips.id, handoff.tripId))
        .limit(1);
      if (!trip) {
        throw new AppError({
          code: 'TRIP_NOT_FOUND',
          message: 'Trip was not found',
          statusCode: 404,
        });
      }

      if (trip.status === 'FEEDBACK_STARTED') {
        if (trip.startedFeedbackAt) {
          return {
            tripId: trip.id,
            status: trip.status,
            startedFeedbackAt: trip.startedFeedbackAt,
          };
        }
        const now = this.now();
        const [repaired] = await tx
          .update(trips)
          .set({ startedFeedbackAt: now, updatedAt: now })
          .where(and(eq(trips.id, trip.id), eq(trips.status, 'FEEDBACK_STARTED')))
          .returning({
            tripId: trips.id,
            status: trips.status,
            startedFeedbackAt: trips.startedFeedbackAt,
          });
        if (repaired?.startedFeedbackAt) {
          return {
            tripId: repaired.tripId,
            status: 'FEEDBACK_STARTED' as const,
            startedFeedbackAt: repaired.startedFeedbackAt,
          };
        }
        this.unavailableHandoff();
      }
      if (trip.status !== 'READY') this.unavailableHandoff();

      const now = this.now();
      const [started] = await tx
        .update(trips)
        .set({ status: 'FEEDBACK_STARTED', startedFeedbackAt: now, updatedAt: now })
        .where(and(eq(trips.id, trip.id), eq(trips.status, 'READY')))
        .returning({
          tripId: trips.id,
          status: trips.status,
          startedFeedbackAt: trips.startedFeedbackAt,
        });
      if (!started?.startedFeedbackAt) this.unavailableHandoff();
      return {
        tripId: started.tripId,
        status: 'FEEDBACK_STARTED' as const,
        startedFeedbackAt: started.startedFeedbackAt,
      };
    });
  }

  async createPhotoUpload(
    token: string,
    input: { readonly contentType: AcceptedPhotoContentType; readonly sizeBytes: number },
  ) {
    this.ensurePhotoStorage();
    const handoff = await this.resolveHandoff(token, true);
    const trip = await this.getTrip(handoff.tripId);
    if (trip.status !== 'FEEDBACK_STARTED') this.unavailableHandoff();
    if (input.sizeBytes > this.photoStorage.maxUploadBytes) {
      throw new AppError({
        code: 'PHOTO_TOO_LARGE',
        message: `Photo must be no larger than ${this.photoStorage.maxUploadBytes} bytes`,
        statusCode: 413,
      });
    }

    const id = randomUUID();
    const uploadObjectKey = this.photoStorage.buildUploadObjectKey(trip.id, id);
    const objectKey = this.photoStorage.buildStoredObjectKey(trip.id, id);
    const expiresAt = new Date(this.now().getTime() + this.photoStorage.uploadUrlTtlSeconds * 1000);
    await this.db.insert(feedbackPhotos).values({
      id,
      tripId: trip.id,
      uploadObjectKey,
      objectKey,
      declaredContentType: input.contentType,
      uploadExpiresAt: expiresAt,
    });
    try {
      const uploadUrl = await this.photoStorage.createUploadUrl(uploadObjectKey, input.contentType);
      return {
        id,
        uploadUrl,
        expiresAt,
        contentType: input.contentType,
        maxBytes: this.photoStorage.maxUploadBytes,
      };
    } catch (error) {
      await this.db.delete(feedbackPhotos).where(eq(feedbackPhotos.id, id));
      throw error;
    }
  }

  async completePhotoUpload(token: string, photoId: string) {
    this.ensurePhotoStorage();
    const handoff = await this.resolveHandoff(token, true);
    const photo = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(feedbackPhotos)
        .where(and(eq(feedbackPhotos.id, photoId), eq(feedbackPhotos.tripId, handoff.tripId)))
        .for('update')
        .limit(1);
      if (!current) this.photoNotFound();
      if (current.status === 'READY' || current.status === 'ATTACHED') return current;
      if (current.status === 'REJECTED') {
        throw new AppError({
          code: 'PHOTO_UPLOAD_REJECTED',
          message: 'The uploaded photo was rejected',
          statusCode: 409,
        });
      }
      if (current.status === 'PROCESSING') return current;
      const [claimed] = await tx
        .update(feedbackPhotos)
        .set({ status: 'PROCESSING' })
        .where(and(eq(feedbackPhotos.id, photoId), eq(feedbackPhotos.status, 'PENDING')))
        .returning();
      if (!claimed) this.photoNotFound();
      return claimed;
    });
    if (photo.status === 'READY' || photo.status === 'ATTACHED')
      return presentCompletedPhoto(photo);

    try {
      const sanitized = await this.photoStorage.sanitize(
        photo.uploadObjectKey,
        photo.objectKey,
        photo.declaredContentType as AcceptedPhotoContentType,
      );
      const completedAt = this.now();
      const [ready] = await this.db
        .update(feedbackPhotos)
        .set({
          status: 'READY',
          storedContentType: sanitized.contentType,
          byteSize: sanitized.byteSize,
          completedAt,
        })
        .where(and(eq(feedbackPhotos.id, photo.id), eq(feedbackPhotos.status, 'PROCESSING')))
        .returning();
      if (!ready) {
        const [concurrentlyCompleted] = await this.db
          .select()
          .from(feedbackPhotos)
          .where(eq(feedbackPhotos.id, photo.id))
          .limit(1);
        if (
          concurrentlyCompleted?.status === 'READY' ||
          concurrentlyCompleted?.status === 'ATTACHED'
        ) {
          return presentCompletedPhoto(concurrentlyCompleted);
        }
        this.photoNotFound();
      }
      return presentCompletedPhoto(ready);
    } catch (error) {
      if (error instanceof InvalidStoredPhotoError) {
        const [rejected] = await this.db
          .update(feedbackPhotos)
          .set({ status: 'REJECTED' })
          .where(and(eq(feedbackPhotos.id, photo.id), eq(feedbackPhotos.status, 'PROCESSING')))
          .returning({ id: feedbackPhotos.id });
        if (rejected) {
          await Promise.allSettled([
            this.photoStorage.delete(photo.uploadObjectKey),
            this.photoStorage.delete(photo.objectKey),
          ]);
        }
        throw new AppError({
          code: 'PHOTO_INVALID',
          message: error.message,
          statusCode: 422,
        });
      }
      await this.db
        .update(feedbackPhotos)
        .set({ status: 'PENDING' })
        .where(and(eq(feedbackPhotos.id, photo.id), eq(feedbackPhotos.status, 'PROCESSING')));
      if (isNotFoundStorageError(error)) {
        throw new AppError({
          code: 'PHOTO_UPLOAD_MISSING',
          message: 'Upload the photo before completing the upload',
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  async submit(token: string, input: SubmitFeedbackInput) {
    const handoff = await this.resolveHandoff(token, false);
    const [replayed] = await this.db
      .select()
      .from(feedbackSubmissions)
      .where(eq(feedbackSubmissions.clientSubmissionId, input.clientSubmissionId))
      .limit(1);
    if (replayed) {
      if (replayed.tripId !== handoff.tripId)
        throw new AppError({
          code: 'CLIENT_SUBMISSION_ID_CONFLICT',
          message: 'This client submission ID belongs to another trip',
          statusCode: 409,
        });
      return receipt(replayed, true);
    }
    const [existingForTrip] = await this.db
      .select({ id: feedbackSubmissions.id })
      .from(feedbackSubmissions)
      .where(eq(feedbackSubmissions.tripId, handoff.tripId))
      .limit(1);
    if (existingForTrip)
      throw new AppError({
        code: 'TRIP_FEEDBACK_ALREADY_SUBMITTED',
        message: 'Feedback has already been submitted for this trip',
        statusCode: 409,
      });
    if (handoff.consumedAt || handoff.expiresAt <= this.now()) this.invalidHandoff();
    const [trip, questionnaireSections] = await Promise.all([
      this.getTrip(handoff.tripId),
      this.loadQuestionnaireSections(handoff),
    ]);
    if (trip.status !== 'FEEDBACK_STARTED') this.unavailableHandoff();
    if (
      input.respondent.bookingReference.trim().toLowerCase() !==
      trip.bookingReference.trim().toLowerCase()
    ) {
      throw new AppError({
        code: 'BOOKING_REFERENCE_MISMATCH',
        message: 'The booking reference does not match this trip',
        statusCode: 400,
      });
    }
    const snapshot = buildCompositeQuestionnaireSnapshot(questionnaireSections);
    if (!isDeepStrictEqual(input.questionnaireSnapshot, snapshot)) {
      throw new AppError({
        code: 'QUESTIONNAIRE_SNAPSHOT_INVALID',
        message: 'The questionnaire snapshot does not match the published version',
        statusCode: 409,
      });
    }
    const normalizedAnswers = validateFeedbackAnswers(
      flattenCompositeQuestions(snapshot),
      input.answers,
    );
    try {
      const submission = await this.db.transaction(async (tx) => {
        let photoToAttach: typeof feedbackPhotos.$inferSelect | undefined;
        if (input.photoId) {
          [photoToAttach] = await tx
            .select()
            .from(feedbackPhotos)
            .where(and(eq(feedbackPhotos.id, input.photoId), eq(feedbackPhotos.tripId, trip.id)))
            .for('update')
            .limit(1);
          if (!photoToAttach || photoToAttach.status !== 'READY') {
            throw new AppError({
              code: 'PHOTO_NOT_READY',
              message: 'The optional photo has not completed uploading',
              statusCode: 409,
            });
          }
        }
        const [created] = await tx
          .insert(feedbackSubmissions)
          .values({
            clientSubmissionId: input.clientSubmissionId,
            tripId: trip.id,
            driverId: trip.driverId,
            driverNameSnapshot: trip.driverNameSnapshot,
            driverSourceSnapshot: trip.driverSourceSnapshot,
            vendorId: trip.vendorId,
            vendorNameSnapshot: trip.vendorNameSnapshot,
            bookingReferenceSnapshot: trip.bookingReference,
            respondentName: input.respondent.name.trim(),
            respondentPhoneCiphertext: this.encryptor.encrypt(input.respondent.phone.trim()),
            respondentEmailCiphertext: this.encryptor.encrypt(
              input.respondent.email.trim().toLowerCase(),
            ),
            respondentBookingReference: input.respondent.bookingReference.trim(),
            consentVersionId: handoff.consentVersionId,
            consentedAt: new Date(input.respondent.consentedAt),
            questionnaireVersionId: null,
            questionnaireSnapshot: snapshot,
            submittedAt: new Date(input.submittedAt),
            submissionMode: input.submissionMode,
          })
          .returning();
        if (!created) throw new Error('Feedback insert did not return a row');
        await tx.insert(feedbackSubmissionSections).values(
          questionnaireSections.map((section) => ({
            feedbackSubmissionId: created.id,
            purpose: section.purpose,
            questionnaireVersionId: section.version.id,
            questionnaireSnapshot: buildQuestionnaireSnapshot(section.version),
            displayOrder: section.displayOrder,
          })),
        );
        if (normalizedAnswers.length)
          await tx.insert(feedbackAnswers).values(
            normalizedAnswers.map((answer) => ({
              feedbackSubmissionId: created.id,
              ...answer,
            })),
          );
        const now = new Date();
        if (photoToAttach) {
          const [attached] = await tx
            .update(feedbackPhotos)
            .set({
              feedbackSubmissionId: created.id,
              status: 'ATTACHED',
              attachedAt: now,
            })
            .where(and(eq(feedbackPhotos.id, photoToAttach.id), eq(feedbackPhotos.status, 'READY')))
            .returning({ id: feedbackPhotos.id });
          if (!attached) {
            throw new AppError({
              code: 'PHOTO_ATTACHMENT_CONFLICT',
              message: 'The optional photo is no longer available',
              statusCode: 409,
            });
          }
        }
        const [submittedTrip] = await tx
          .update(trips)
          .set({ status: 'SUBMITTED', updatedAt: now })
          .where(and(eq(trips.id, trip.id), eq(trips.status, 'FEEDBACK_STARTED')))
          .returning({ id: trips.id });
        if (!submittedTrip) {
          throw new AppError({
            code: 'TRIP_FEEDBACK_STATE_CONFLICT',
            message: 'The trip is no longer accepting feedback',
            statusCode: 409,
          });
        }
        await tx
          .update(feedbackHandoffs)
          .set({ consumedAt: now })
          .where(eq(feedbackHandoffs.id, handoff.id));
        return created;
      });
      return receipt(submission, false);
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        const [sameClient] = await this.db
          .select()
          .from(feedbackSubmissions)
          .where(eq(feedbackSubmissions.clientSubmissionId, input.clientSubmissionId))
          .limit(1);
        if (sameClient && sameClient.tripId === handoff.tripId) return receipt(sameClient, true);
        throw new AppError({
          code: 'TRIP_FEEDBACK_ALREADY_SUBMITTED',
          message: 'Feedback has already been submitted for this trip',
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  private async resolveHandoff(token: string, enforceUsable: boolean) {
    if (!token) this.invalidHandoff();
    const [handoff] = await this.db
      .select()
      .from(feedbackHandoffs)
      .where(eq(feedbackHandoffs.tokenHash, hashToken(token)))
      .limit(1);
    if (!handoff || (enforceUsable && (handoff.consumedAt || handoff.expiresAt <= this.now())))
      this.invalidHandoff();
    return handoff;
  }

  private async loadQuestionnaireSections(
    handoff: typeof feedbackHandoffs.$inferSelect,
  ): Promise<FeedbackQuestionnaireSection[]> {
    const rows = await this.db
      .select({
        purpose: feedbackHandoffSections.purpose,
        questionnaireVersionId: feedbackHandoffSections.questionnaireVersionId,
        displayOrder: feedbackHandoffSections.displayOrder,
      })
      .from(feedbackHandoffSections)
      .where(eq(feedbackHandoffSections.handoffId, handoff.id))
      .orderBy(feedbackHandoffSections.displayOrder);
    if (!rows.length && handoff.questionnaireVersionId) {
      return [
        {
          purpose: 'DRIVER_FEEDBACK',
          displayOrder: 0,
          version: await this.questionnaires.getVersionById(handoff.questionnaireVersionId),
        },
      ];
    }
    if (!rows.length) this.invalidHandoff();
    return Promise.all(
      rows.map(async (row) => ({
        purpose: row.purpose,
        displayOrder: row.displayOrder,
        version: await this.questionnaires.getVersionById(row.questionnaireVersionId),
      })),
    );
  }

  private async getTrip(id: string) {
    const [trip] = await this.db
      .select({ ...getTableColumns(trips), bookingReference: bookings.bookingReference })
      .from(trips)
      .innerJoin(bookings, eq(bookings.id, trips.bookingId))
      .where(eq(trips.id, id))
      .limit(1);
    if (!trip)
      throw new AppError({
        code: 'TRIP_NOT_FOUND',
        message: 'Trip was not found',
        statusCode: 404,
      });
    return trip;
  }

  private invalidHandoff(): never {
    throw new AppError({
      code: 'FEEDBACK_HANDOFF_INVALID',
      message: 'The feedback handoff is invalid or expired',
      statusCode: 401,
    });
  }

  private ensurePhotoStorage(): void {
    if (!this.photoStorage.enabled) {
      throw new AppError({
        code: 'PHOTO_STORAGE_UNAVAILABLE',
        message: 'Photo uploads are temporarily unavailable',
        statusCode: 503,
      });
    }
  }

  private photoNotFound(): never {
    throw new AppError({
      code: 'PHOTO_UPLOAD_NOT_FOUND',
      message: 'Photo upload was not found',
      statusCode: 404,
    });
  }

  private unavailableHandoff(): never {
    throw new AppError({
      code: 'FEEDBACK_HANDOFF_UNAVAILABLE',
      message: 'Passenger feedback is unavailable for this trip',
      statusCode: 409,
    });
  }

  private buildHandoffLink(token: string): string {
    const link = new URL(this.passengerFeedbackUrl);
    link.searchParams.set('token', token);
    return link.toString();
  }
}

function presentCompletedPhoto(photo: typeof feedbackPhotos.$inferSelect) {
  if (photo.storedContentType !== 'image/jpeg' || photo.byteSize === null || !photo.completedAt) {
    throw new Error('Completed feedback photo is missing stored metadata');
  }
  return {
    id: photo.id,
    status: 'READY' as const,
    contentType: 'image/jpeg' as const,
    byteSize: photo.byteSize,
    completedAt: photo.completedAt,
  };
}

function isNotFoundStorageError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    typeof error.$metadata === 'object' &&
    error.$metadata !== null &&
    'httpStatusCode' in error.$metadata &&
    error.$metadata.httpStatusCode === 404
  );
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function sectionOrderSql(column: typeof tripFeedbackSections.purpose) {
  return sql`case ${column}
    when 'ARRIVAL_EXPERIENCE' then 0
    when 'DRIVER_FEEDBACK' then 1
    when 'TOUR_EXPERIENCE' then 2
  end`;
}

function receipt(
  row: {
    id: string;
    clientSubmissionId: string;
    tripId: string;
    receivedAt: Date;
    submissionMode: 'ONLINE' | 'OFFLINE_SYNC';
  },
  replayed: boolean,
) {
  return {
    id: row.id,
    clientSubmissionId: row.clientSubmissionId,
    tripId: row.tripId,
    receivedAt: row.receivedAt,
    submissionMode: row.submissionMode,
    replayed,
    rewardEligible: row.submissionMode === 'ONLINE',
  };
}
