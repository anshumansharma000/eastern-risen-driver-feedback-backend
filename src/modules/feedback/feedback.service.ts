import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  feedbackAnswers,
  feedbackHandoffs,
  feedbackSubmissions,
  bookings,
  trips,
} from '../../database/schema/index.js';
import { isPostgresError } from '../../shared/database/postgres-error.js';
import type { FieldEncryptor } from '../../shared/security/field-encryption.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { QuestionnaireService } from '../questionnaires/questionnaire.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { validateFeedbackAnswers } from './answer.validator.js';
import { buildQuestionnaireSnapshot } from './questionnaire-snapshot.js';

export interface SubmitFeedbackInput {
  readonly clientSubmissionId: string;
  readonly questionnaireVersionId: string;
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
}

export class FeedbackService {
  constructor(
    private readonly db: AppDatabase,
    private readonly questionnaires: QuestionnaireService,
    private readonly settings: SettingsService,
    private readonly encryptor: FieldEncryptor,
    private readonly handoffTtlHours: number,
    private readonly passengerFeedbackUrl: string,
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

      const [version, consent] = await Promise.all([
        this.questionnaires.getActiveVersion(),
        this.questionnaires.getActiveConsent(),
      ]);
      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const tokenCiphertext = this.encryptor.encrypt(token);
      const expiresAt = new Date(now.getTime() + this.handoffTtlHours * 60 * 60 * 1000);

      if (existingHandoff) {
        await tx
          .update(feedbackHandoffs)
          .set({
            questionnaireVersionId: version.id,
            consentVersionId: consent.id,
            tokenHash,
            tokenCiphertext,
            expiresAt,
            consumedAt: null,
          })
          .where(eq(feedbackHandoffs.id, existingHandoff.id));
      } else {
        await tx.insert(feedbackHandoffs).values({
          tripId,
          questionnaireVersionId: version.id,
          consentVersionId: consent.id,
          tokenHash,
          tokenCiphertext,
          expiresAt,
        });
      }

      return { tripId, token, expiresAt, link: this.buildHandoffLink(token) };
    });
  }

  async getContext(token: string) {
    const handoff = await this.resolveHandoff(token, true);
    const [trip, version, settings] = await Promise.all([
      this.getTrip(handoff.tripId),
      this.questionnaires.getVersionById(handoff.questionnaireVersionId),
      this.settings.get(),
    ]);
    const consent = await this.questionnaires.getConsentById(handoff.consentVersionId);
    if (trip.status !== 'READY' && trip.status !== 'FEEDBACK_STARTED') this.invalidHandoff();
    return { trip, version, consent, settings, snapshot: buildQuestionnaireSnapshot(version) };
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
    if (input.questionnaireVersionId !== handoff.questionnaireVersionId)
      throw new AppError({
        code: 'QUESTIONNAIRE_VERSION_INVALID',
        message: 'The questionnaire version does not match this handoff',
        statusCode: 409,
      });
    const [trip, version] = await Promise.all([
      this.getTrip(handoff.tripId),
      this.questionnaires.getVersionById(handoff.questionnaireVersionId),
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
    const snapshot = buildQuestionnaireSnapshot(version);
    if (!isDeepStrictEqual(input.questionnaireSnapshot, snapshot)) {
      throw new AppError({
        code: 'QUESTIONNAIRE_SNAPSHOT_INVALID',
        message: 'The questionnaire snapshot does not match the published version',
        statusCode: 409,
      });
    }
    const normalizedAnswers = validateFeedbackAnswers(version.questions, input.answers);
    try {
      const submission = await this.db.transaction(async (tx) => {
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
            questionnaireVersionId: handoff.questionnaireVersionId,
            questionnaireSnapshot: snapshot,
            submittedAt: new Date(input.submittedAt),
            submissionMode: input.submissionMode,
          })
          .returning();
        if (!created) throw new Error('Feedback insert did not return a row');
        if (normalizedAnswers.length)
          await tx.insert(feedbackAnswers).values(
            normalizedAnswers.map((answer) => ({
              feedbackSubmissionId: created.id,
              ...answer,
            })),
          );
        const now = new Date();
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

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
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
