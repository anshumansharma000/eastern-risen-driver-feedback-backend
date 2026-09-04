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
  bookingDriverEngagements,
  bookings,
  engagementFeedbackSections,
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

  async issueHandoff(engagementId: string) {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ bookingId: bookingDriverEngagements.bookingId })
        .from(bookingDriverEngagements)
        .where(eq(bookingDriverEngagements.id, engagementId))
        .limit(1);
      if (!candidate) {
        throw new AppError({
          code: 'ENGAGEMENT_NOT_FOUND',
          message: 'Driver engagement was not found',
          statusCode: 404,
        });
      }
      // Schedule mutation, handoff issuance, and passenger start all take these
      // locks in the same order, preventing stale tokens and regrouping races.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${'booking:' + candidate.bookingId}, 0))`,
      );
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${engagementId}, 0))`);

      const [existingSubmission] = await tx
        .select({ id: feedbackSubmissions.id })
        .from(feedbackSubmissions)
        .where(eq(feedbackSubmissions.engagementId, engagementId))
        .limit(1);
      const [engagement] = await tx
        .select()
        .from(bookingDriverEngagements)
        .where(eq(bookingDriverEngagements.id, engagementId))
        .limit(1);
      if (
        existingSubmission ||
        (engagement?.status !== 'READY' && engagement?.status !== 'FEEDBACK_STARTED')
      ) {
        throw new AppError({
          code: 'FEEDBACK_HANDOFF_UNAVAILABLE',
          message: 'Passenger feedback is unavailable for this engagement',
          statusCode: 409,
        });
      }
      const [existingHandoff] = await tx
        .select()
        .from(feedbackHandoffs)
        .where(eq(feedbackHandoffs.engagementId, engagementId))
        .limit(1);
      const now = this.now();
      if (existingHandoff && !existingHandoff.consumedAt && existingHandoff.expiresAt > now) {
        const token = this.encryptor.decrypt(existingHandoff.tokenCiphertext);
        return {
          engagementId,
          token,
          expiresAt: existingHandoff.expiresAt,
          link: this.buildHandoffLink(token),
        };
      }

      const assignedSections = await tx
        .select({ purpose: engagementFeedbackSections.purpose })
        .from(engagementFeedbackSections)
        .where(eq(engagementFeedbackSections.engagementId, engagementId))
        .orderBy(sectionOrderSql(engagementFeedbackSections.purpose));
      if (!assignedSections.length) {
        throw new AppError({
          code: 'ENGAGEMENT_FEEDBACK_SECTIONS_REQUIRED',
          message: 'The engagement has no feedback sections',
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
            engagementId,
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

      return { engagementId, token, expiresAt, link: this.buildHandoffLink(token) };
    });
  }

  async getContext(token: string) {
    const handoff = await this.resolveHandoff(token, true);
    const [engagement, questionnaireSections, settings] = await Promise.all([
      this.getEngagement(handoff.engagementId),
      this.loadQuestionnaireSections(handoff),
      this.settings.get(),
    ]);
    const consent = await this.questionnaires.getConsentById(handoff.consentVersionId);
    if (engagement.status !== 'READY' && engagement.status !== 'FEEDBACK_STARTED')
      this.invalidHandoff();
    return {
      engagement,
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

      const [candidateEngagement] = await tx
        .select({ bookingId: bookingDriverEngagements.bookingId })
        .from(bookingDriverEngagements)
        .where(eq(bookingDriverEngagements.id, candidate.engagementId))
        .limit(1);
      if (!candidateEngagement) this.invalidHandoff();

      // Share the engagement-scoped lock used by handoff issuance so token replacement
      // and concurrent passenger starts cannot observe each other halfway through.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${'booking:' + candidateEngagement.bookingId}, 0))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${candidate.engagementId}, 0))`,
      );
      const [handoff] = await tx
        .select()
        .from(feedbackHandoffs)
        .where(eq(feedbackHandoffs.tokenHash, tokenHash))
        .limit(1);
      if (!handoff || handoff.consumedAt || handoff.expiresAt <= this.now()) {
        this.invalidHandoff();
      }

      const [engagement] = await tx
        .select({
          id: bookingDriverEngagements.id,
          status: bookingDriverEngagements.status,
          startedFeedbackAt: bookingDriverEngagements.startedFeedbackAt,
        })
        .from(bookingDriverEngagements)
        .where(eq(bookingDriverEngagements.id, handoff.engagementId))
        .limit(1);
      if (!engagement) {
        throw new AppError({
          code: 'ENGAGEMENT_NOT_FOUND',
          message: 'Driver engagement was not found',
          statusCode: 404,
        });
      }

      if (engagement.status === 'FEEDBACK_STARTED') {
        if (engagement.startedFeedbackAt) {
          return {
            engagementId: engagement.id,
            status: engagement.status,
            startedFeedbackAt: engagement.startedFeedbackAt,
          };
        }
        const now = this.now();
        const [repaired] = await tx
          .update(bookingDriverEngagements)
          .set({ startedFeedbackAt: now, updatedAt: now })
          .where(
            and(
              eq(bookingDriverEngagements.id, engagement.id),
              eq(bookingDriverEngagements.status, 'FEEDBACK_STARTED'),
            ),
          )
          .returning({
            engagementId: bookingDriverEngagements.id,
            status: bookingDriverEngagements.status,
            startedFeedbackAt: bookingDriverEngagements.startedFeedbackAt,
          });
        if (repaired?.startedFeedbackAt) {
          return {
            engagementId: repaired.engagementId,
            status: 'FEEDBACK_STARTED' as const,
            startedFeedbackAt: repaired.startedFeedbackAt,
          };
        }
        this.unavailableHandoff();
      }
      if (engagement.status !== 'READY') this.unavailableHandoff();

      const now = this.now();
      const [started] = await tx
        .update(bookingDriverEngagements)
        .set({ status: 'FEEDBACK_STARTED', startedFeedbackAt: now, updatedAt: now })
        .where(
          and(
            eq(bookingDriverEngagements.id, engagement.id),
            eq(bookingDriverEngagements.status, 'READY'),
          ),
        )
        .returning({
          engagementId: bookingDriverEngagements.id,
          status: bookingDriverEngagements.status,
          startedFeedbackAt: bookingDriverEngagements.startedFeedbackAt,
        });
      if (!started?.startedFeedbackAt) this.unavailableHandoff();
      return {
        engagementId: started.engagementId,
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
    const engagement = await this.getEngagement(handoff.engagementId);
    if (engagement.status !== 'FEEDBACK_STARTED') this.unavailableHandoff();
    if (input.sizeBytes > this.photoStorage.maxUploadBytes) {
      throw new AppError({
        code: 'PHOTO_TOO_LARGE',
        message: `Photo must be no larger than ${this.photoStorage.maxUploadBytes} bytes`,
        statusCode: 413,
      });
    }

    const id = randomUUID();
    const uploadObjectKey = this.photoStorage.buildUploadObjectKey(engagement.id, id);
    const objectKey = this.photoStorage.buildStoredObjectKey(engagement.id, id);
    const expiresAt = new Date(this.now().getTime() + this.photoStorage.uploadUrlTtlSeconds * 1000);
    await this.db.insert(feedbackPhotos).values({
      id,
      engagementId: engagement.id,
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
        .where(
          and(
            eq(feedbackPhotos.id, photoId),
            eq(feedbackPhotos.engagementId, handoff.engagementId),
          ),
        )
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
      if (replayed.engagementId !== handoff.engagementId)
        throw new AppError({
          code: 'CLIENT_SUBMISSION_ID_CONFLICT',
          message: 'This client submission ID belongs to another engagement',
          statusCode: 409,
        });
      return receipt(replayed, true);
    }
    const [existingForEngagement] = await this.db
      .select({ id: feedbackSubmissions.id })
      .from(feedbackSubmissions)
      .where(eq(feedbackSubmissions.engagementId, handoff.engagementId))
      .limit(1);
    if (existingForEngagement)
      throw new AppError({
        code: 'ENGAGEMENT_FEEDBACK_ALREADY_SUBMITTED',
        message: 'Feedback has already been submitted for this engagement',
        statusCode: 409,
      });
    if (handoff.consumedAt || handoff.expiresAt <= this.now()) this.invalidHandoff();
    const [engagement, questionnaireSections] = await Promise.all([
      this.getEngagement(handoff.engagementId),
      this.loadQuestionnaireSections(handoff),
    ]);
    if (engagement.status !== 'FEEDBACK_STARTED') this.unavailableHandoff();
    if (
      input.respondent.bookingReference.trim().toLowerCase() !==
      engagement.bookingReference.trim().toLowerCase()
    ) {
      throw new AppError({
        code: 'BOOKING_REFERENCE_MISMATCH',
        message: 'The booking reference does not match this engagement',
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
            .where(
              and(
                eq(feedbackPhotos.id, input.photoId),
                eq(feedbackPhotos.engagementId, engagement.id),
              ),
            )
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
            engagementId: engagement.id,
            driverId: engagement.driverId,
            driverNameSnapshot: engagement.driverNameSnapshot,
            driverSourceSnapshot: engagement.driverSourceSnapshot,
            vendorId: engagement.vendorId,
            vendorNameSnapshot: engagement.vendorNameSnapshot,
            bookingReferenceSnapshot: engagement.bookingReference,
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
        const [submittedEngagement] = await tx
          .update(bookingDriverEngagements)
          .set({ status: 'SUBMITTED', updatedAt: now })
          .where(
            and(
              eq(bookingDriverEngagements.id, engagement.id),
              eq(bookingDriverEngagements.status, 'FEEDBACK_STARTED'),
            ),
          )
          .returning({ id: bookingDriverEngagements.id });
        if (!submittedEngagement) {
          throw new AppError({
            code: 'ENGAGEMENT_FEEDBACK_STATE_CONFLICT',
            message: 'The engagement is no longer accepting feedback',
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
        if (sameClient && sameClient.engagementId === handoff.engagementId)
          return receipt(sameClient, true);
        throw new AppError({
          code: 'ENGAGEMENT_FEEDBACK_ALREADY_SUBMITTED',
          message: 'Feedback has already been submitted for this engagement',
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

  private async getEngagement(id: string) {
    const [engagement] = await this.db
      .select({
        ...getTableColumns(bookingDriverEngagements),
        bookingReference: bookings.bookingReference,
      })
      .from(bookingDriverEngagements)
      .innerJoin(bookings, eq(bookings.id, bookingDriverEngagements.bookingId))
      .where(eq(bookingDriverEngagements.id, id))
      .limit(1);
    if (!engagement)
      throw new AppError({
        code: 'ENGAGEMENT_NOT_FOUND',
        message: 'Driver engagement was not found',
        statusCode: 404,
      });
    const engagementTrips = await this.db
      .select()
      .from(trips)
      .where(eq(trips.engagementId, engagement.id))
      .orderBy(trips.scheduledAt, trips.createdAt, trips.id);
    if (!engagementTrips.length && engagement.status !== 'ARCHIVED') {
      throw new Error(`Active engagement ${engagement.id} has no trips`);
    }
    return { ...engagement, trips: engagementTrips };
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
        developerMessage: 'Photo storage is disabled because the R2 configuration is incomplete.',
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
      message: 'Passenger feedback is unavailable for this engagement',
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

function sectionOrderSql(column: typeof engagementFeedbackSections.purpose) {
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
    engagementId: string;
    receivedAt: Date;
    submissionMode: 'ONLINE' | 'OFFLINE_SYNC';
  },
  replayed: boolean,
) {
  return {
    id: row.id,
    clientSubmissionId: row.clientSubmissionId,
    engagementId: row.engagementId,
    receivedAt: row.receivedAt,
    submissionMode: row.submissionMode,
    replayed,
    rewardEligible: row.submissionMode === 'ONLINE',
  };
}
