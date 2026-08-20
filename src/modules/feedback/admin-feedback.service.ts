import { and, asc, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  auditEvents,
  authAccounts,
  feedbackAnswers,
  feedbackPhotos,
  feedbackReviewEvents,
  feedbackSubmissions,
  feedbackSubmissionSections,
  trips,
} from '../../database/schema/index.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { FieldEncryptor } from '../../shared/security/field-encryption.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { PhotoStorage } from '../../shared/storage/photo-storage.js';

type DriverSource = 'AGENCY' | 'OUTSOURCED';
type ReviewState = 'NORMAL' | 'FLAGGED' | 'ARCHIVED';
type SubmissionMode = 'ONLINE' | 'OFFLINE_SYNC';
export type FeedbackView = 'DRIVER' | 'COMPANY';
type Category =
  | 'OVERALL_EXPERIENCE'
  | 'DRIVING_SAFETY'
  | 'PUNCTUALITY'
  | 'CLEANLINESS'
  | 'PROFESSIONALISM'
  | 'VEHICLE_CONDITION'
  | 'ARRIVAL_EXPERIENCE'
  | 'TOUR_EXPERIENCE'
  | 'TOUR_COORDINATION'
  | 'CUSTOM';

export interface ListAdminFeedbackInput {
  readonly page: number;
  readonly pageSize: number;
  readonly view: FeedbackView;
  readonly month?: string;
  readonly driverId?: string;
  readonly driverSource?: DriverSource;
  readonly vendorId?: string;
  readonly reviewState?: ReviewState;
  readonly submissionMode?: SubmissionMode;
  readonly category?: Category;
  readonly minimumScore?: number;
  readonly maximumScore?: number;
  readonly negativeOnly?: boolean;
}

const aggregateOverallScore = sql<
  number | null
>`avg(${feedbackAnswers.numericScore})::double precision`;

export class AdminFeedbackService {
  constructor(
    private readonly db: AppDatabase,
    private readonly encryptor: FieldEncryptor,
    private readonly settings: SettingsService,
    private readonly photoStorage: PhotoStorage,
  ) {}

  async list(input: ListAdminFeedbackInput) {
    const settings = await this.settings.get();
    if (input.negativeOnly && settings.negativeFeedbackThreshold === null) {
      throw new AppError({
        code: 'NEGATIVE_FEEDBACK_THRESHOLD_REQUIRED',
        message: 'Configure a negative feedback threshold before using this filter',
        statusCode: 409,
      });
    }

    const filter = buildFilter(input, settings.timezone, settings.negativeFeedbackThreshold);
    const offset = (input.page - 1) * input.pageSize;
    const [items, [total]] = await Promise.all([
      this.db
        .select({
          id: feedbackSubmissions.id,
          tripId: feedbackSubmissions.tripId,
          bookingReference: feedbackSubmissions.bookingReferenceSnapshot,
          respondentName: feedbackSubmissions.respondentName,
          driverId: feedbackSubmissions.driverId,
          driverName: feedbackSubmissions.driverNameSnapshot,
          driverSource: feedbackSubmissions.driverSourceSnapshot,
          vendorId: feedbackSubmissions.vendorId,
          vendorName: feedbackSubmissions.vendorNameSnapshot,
          submittedAt: feedbackSubmissions.submittedAt,
          receivedAt: feedbackSubmissions.receivedAt,
          submissionMode: feedbackSubmissions.submissionMode,
          reviewState: feedbackSubmissions.currentReviewState,
          overallScore: aggregateOverallScore,
        })
        .from(feedbackSubmissions)
        .leftJoin(
          feedbackAnswers,
          and(
            eq(feedbackAnswers.feedbackSubmissionId, feedbackSubmissions.id),
            answerPurposeCondition(input.view),
          ),
        )
        .where(filter)
        .groupBy(
          feedbackSubmissions.id,
          feedbackSubmissions.tripId,
          feedbackSubmissions.bookingReferenceSnapshot,
          feedbackSubmissions.respondentName,
          feedbackSubmissions.driverId,
          feedbackSubmissions.driverNameSnapshot,
          feedbackSubmissions.driverSourceSnapshot,
          feedbackSubmissions.vendorId,
          feedbackSubmissions.vendorNameSnapshot,
          feedbackSubmissions.submittedAt,
          feedbackSubmissions.receivedAt,
          feedbackSubmissions.submissionMode,
          feedbackSubmissions.currentReviewState,
        )
        .orderBy(desc(feedbackSubmissions.submittedAt), desc(feedbackSubmissions.id))
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(feedbackSubmissions).where(filter),
    ]);
    return { items, total: total?.value ?? 0, timezone: settings.timezone };
  }

  async get(id: string, view?: FeedbackView) {
    const [row] = await this.db
      .select({
        submission: feedbackSubmissions,
        trip: {
          pickupLocation: trips.pickupLocation,
          destination: trips.destination,
          scheduledAt: trips.scheduledAt,
          scheduledEndAt: trips.scheduledEndAt,
          vehicleSnapshot: trips.vehicleSnapshot,
        },
      })
      .from(feedbackSubmissions)
      .innerJoin(trips, eq(feedbackSubmissions.tripId, trips.id))
      .where(eq(feedbackSubmissions.id, id))
      .limit(1);
    if (!row) this.notFound();

    const [sections, answers, history, [photo]] = await Promise.all([
      this.db
        .select({
          purpose: feedbackSubmissionSections.purpose,
          questionnaireVersionId: feedbackSubmissionSections.questionnaireVersionId,
          displayOrder: feedbackSubmissionSections.displayOrder,
        })
        .from(feedbackSubmissionSections)
        .where(
          and(
            eq(feedbackSubmissionSections.feedbackSubmissionId, id),
            view ? sectionPurposeCondition(view) : undefined,
          ),
        )
        .orderBy(feedbackSubmissionSections.displayOrder),
      this.db
        .select()
        .from(feedbackAnswers)
        .where(
          and(
            eq(feedbackAnswers.feedbackSubmissionId, id),
            view ? answerPurposeCondition(view) : undefined,
          ),
        )
        .orderBy(
          sql`case ${feedbackAnswers.questionnairePurposeSnapshot}
            when 'ARRIVAL_EXPERIENCE' then 0
            when 'DRIVER_FEEDBACK' then 1
            when 'TOUR_EXPERIENCE' then 2
          end`,
          asc(feedbackAnswers.displayOrderSnapshot),
          asc(feedbackAnswers.id),
        ),
      this.db
        .select({
          id: feedbackReviewEvents.id,
          action: feedbackReviewEvents.action,
          reason: feedbackReviewEvents.reason,
          performedByAccountId: feedbackReviewEvents.performedByAccountId,
          performedByDisplayName: authAccounts.displayName,
          createdAt: feedbackReviewEvents.createdAt,
        })
        .from(feedbackReviewEvents)
        .innerJoin(authAccounts, eq(feedbackReviewEvents.performedByAccountId, authAccounts.id))
        .where(eq(feedbackReviewEvents.feedbackSubmissionId, id))
        .orderBy(asc(feedbackReviewEvents.createdAt), asc(feedbackReviewEvents.id)),
      this.db
        .select({
          id: feedbackPhotos.id,
          contentType: feedbackPhotos.storedContentType,
          byteSize: feedbackPhotos.byteSize,
          attachedAt: feedbackPhotos.attachedAt,
        })
        .from(feedbackPhotos)
        .where(
          and(eq(feedbackPhotos.feedbackSubmissionId, id), eq(feedbackPhotos.status, 'ATTACHED')),
        )
        .limit(1),
    ]);

    if (view && answers.length === 0) this.notFound();

    return {
      ...row,
      answers,
      sections,
      history,
      photo: photo ?? null,
      overallScore: average(
        answers
          .map((answer) => answer.numericScore)
          .filter((score): score is number => score !== null),
      ),
      respondentPhone: this.encryptor.decrypt(row.submission.respondentPhoneCiphertext),
      respondentEmail: this.encryptor.decrypt(row.submission.respondentEmailCiphertext),
    };
  }

  async getPhotoAccess(id: string) {
    if (!this.photoStorage.enabled) {
      throw new AppError({
        code: 'PHOTO_STORAGE_UNAVAILABLE',
        message: 'Photo storage is temporarily unavailable',
        statusCode: 503,
      });
    }
    const [photo] = await this.db
      .select()
      .from(feedbackPhotos)
      .where(
        and(eq(feedbackPhotos.feedbackSubmissionId, id), eq(feedbackPhotos.status, 'ATTACHED')),
      )
      .limit(1);
    if (!photo || !photo.storedContentType || photo.byteSize === null || !photo.attachedAt) {
      throw new AppError({
        code: 'FEEDBACK_PHOTO_NOT_FOUND',
        message: 'This feedback submission has no photo',
        statusCode: 404,
      });
    }
    const url = await this.photoStorage.createDownloadUrl(photo.objectKey);
    return {
      id: photo.id,
      url,
      expiresAt: new Date(Date.now() + this.photoStorage.downloadUrlTtlSeconds * 1000),
      contentType: photo.storedContentType,
      byteSize: photo.byteSize,
    };
  }

  async updateReviewState(
    id: string,
    state: ReviewState,
    reason: string | undefined,
    actorAccountId: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
      const [current] = await tx
        .select()
        .from(feedbackSubmissions)
        .where(eq(feedbackSubmissions.id, id))
        .limit(1);
      if (!current) this.notFound();
      if (current.currentReviewState === state) return current;
      if (current.currentReviewState === 'ARCHIVED') {
        throw new AppError({
          code: 'FEEDBACK_RESTORE_NOT_SUPPORTED',
          message: 'Archived feedback cannot currently be restored',
          statusCode: 409,
        });
      }
      if (state === 'ARCHIVED' && !reason?.trim()) {
        throw new AppError({
          code: 'FEEDBACK_ARCHIVE_REASON_REQUIRED',
          message: 'A reason is required when archiving feedback',
          statusCode: 400,
        });
      }

      const action =
        state === 'ARCHIVED'
          ? ('ARCHIVE' as const)
          : state === 'FLAGGED'
            ? ('FLAG' as const)
            : ('UNFLAG' as const);
      if (action === 'UNFLAG' && current.currentReviewState !== 'FLAGGED') {
        throw new AppError({
          code: 'FEEDBACK_REVIEW_TRANSITION_INVALID',
          message: 'Only flagged feedback can be returned to the normal state',
          statusCode: 409,
        });
      }

      const now = new Date();
      const [updated] = await tx
        .update(feedbackSubmissions)
        .set({
          currentReviewState: state,
          archivedAt: state === 'ARCHIVED' ? now : null,
          archivedByAccountId: state === 'ARCHIVED' ? actorAccountId : null,
        })
        .where(eq(feedbackSubmissions.id, id))
        .returning();
      if (!updated) this.notFound();

      await tx.insert(feedbackReviewEvents).values({
        feedbackSubmissionId: id,
        action,
        reason: reason?.trim() || null,
        performedByAccountId: actorAccountId,
      });
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: `FEEDBACK_${action}`,
        entityType: 'FEEDBACK_SUBMISSION',
        entityId: id,
        metadata: { state, reasonProvided: Boolean(reason?.trim()) },
      });
      return updated;
    });
  }

  private notFound(): never {
    throw new AppError({
      code: 'FEEDBACK_NOT_FOUND',
      message: 'Feedback was not found',
      statusCode: 404,
    });
  }
}

function buildFilter(
  input: ListAdminFeedbackInput,
  timezone: string,
  negativeThreshold: number | null,
): SQL | undefined {
  const conditions: SQL[] = [];
  conditions.push(sql`exists (
    select 1 from feedback_answers view_answer
    where view_answer.feedback_submission_id = ${feedbackSubmissions.id}
      and ${rawPurposeCondition(input.view, sql`view_answer.questionnaire_purpose_snapshot`)}
  )`);
  if (input.month) conditions.push(monthCondition(input.month, timezone));
  if (input.driverId) conditions.push(eq(feedbackSubmissions.driverId, input.driverId));
  if (input.driverSource)
    conditions.push(eq(feedbackSubmissions.driverSourceSnapshot, input.driverSource));
  if (input.vendorId) conditions.push(eq(feedbackSubmissions.vendorId, input.vendorId));
  if (input.reviewState)
    conditions.push(eq(feedbackSubmissions.currentReviewState, input.reviewState));
  if (input.submissionMode)
    conditions.push(eq(feedbackSubmissions.submissionMode, input.submissionMode));
  if (input.category) {
    conditions.push(sql`exists (
      select 1 from feedback_answers answer
      where answer.feedback_submission_id = ${feedbackSubmissions.id}
        and answer.category_snapshot = ${input.category}
        and ${rawPurposeCondition(input.view, sql`answer.questionnaire_purpose_snapshot`)}
    )`);
  }
  const viewOverallScore = correlatedOverallScore(input.view);
  if (input.minimumScore !== undefined) conditions.push(gte(viewOverallScore, input.minimumScore));
  if (input.maximumScore !== undefined) conditions.push(lte(viewOverallScore, input.maximumScore));
  if (input.negativeOnly && negativeThreshold !== null)
    conditions.push(lte(viewOverallScore, negativeThreshold));
  return conditions.length ? and(...conditions) : undefined;
}

function answerPurposeCondition(view: FeedbackView): SQL {
  return view === 'DRIVER'
    ? eq(feedbackAnswers.questionnairePurposeSnapshot, 'DRIVER_FEEDBACK')
    : inArray(feedbackAnswers.questionnairePurposeSnapshot, [
        'ARRIVAL_EXPERIENCE',
        'TOUR_EXPERIENCE',
      ]);
}

function sectionPurposeCondition(view: FeedbackView): SQL {
  return view === 'DRIVER'
    ? eq(feedbackSubmissionSections.purpose, 'DRIVER_FEEDBACK')
    : inArray(feedbackSubmissionSections.purpose, ['ARRIVAL_EXPERIENCE', 'TOUR_EXPERIENCE']);
}

function rawPurposeCondition(view: FeedbackView, column: SQL): SQL {
  return view === 'DRIVER'
    ? sql`${column} = 'DRIVER_FEEDBACK'`
    : sql`${column} in ('ARRIVAL_EXPERIENCE', 'TOUR_EXPERIENCE')`;
}

function correlatedOverallScore(view: FeedbackView): SQL<number | null> {
  return sql<number | null>`(
    select avg(answer.numeric_score)::double precision
    from feedback_answers answer
    where answer.feedback_submission_id = ${feedbackSubmissions.id}
      and answer.numeric_score is not null
      and ${rawPurposeCondition(view, sql`answer.questionnaire_purpose_snapshot`)}
  )`;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function monthCondition(month: string, timezone: string): SQL {
  return sql`${feedbackSubmissions.submittedAt} >=
      ((${month} || '-01')::date::timestamp at time zone ${timezone})
    and ${feedbackSubmissions.submittedAt} <
      ((((${month} || '-01')::date + interval '1 month')::timestamp) at time zone ${timezone})`;
}
