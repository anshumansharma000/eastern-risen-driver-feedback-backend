import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { paginationSchema } from '../../shared/http/response.schemas.js';
import type { AuthGuards } from '../auth/auth.guard.js';
import {
  adminFeedbackDetailSchema,
  adminFeedbackListQuerySchema,
  adminFeedbackSummarySchema,
  updateFeedbackReviewBodySchema,
} from './admin-feedback.schemas.js';
import type { AdminFeedbackService } from './admin-feedback.service.js';

export interface AdminFeedbackRouteOptions {
  readonly guards: AuthGuards;
  readonly adminFeedbackService: AdminFeedbackService;
}

const idParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const adminFeedbackRoutes: FastifyPluginAsyncTypebox<AdminFeedbackRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.admin);

  app.get(
    '/',
    {
      schema: {
        tags: ['feedback review'],
        summary: 'List and filter passenger feedback',
        querystring: adminFeedbackListQuerySchema,
        response: {
          200: Type.Object({
            data: Type.Array(adminFeedbackSummarySchema),
            pagination: paginationSchema,
            meta: Type.Object({ timezone: Type.String(), dateBasis: Type.Literal('SUBMITTED_AT') }),
          }),
        },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 25;
      const result = await options.adminFeedbackService.list({
        page,
        pageSize,
        ...(request.query.month ? { month: request.query.month } : {}),
        ...(request.query.driverId ? { driverId: request.query.driverId } : {}),
        ...(request.query.driverSource ? { driverSource: request.query.driverSource } : {}),
        ...(request.query.vendorId ? { vendorId: request.query.vendorId } : {}),
        ...(request.query.reviewState ? { reviewState: request.query.reviewState } : {}),
        ...(request.query.submissionMode ? { submissionMode: request.query.submissionMode } : {}),
        ...(request.query.category ? { category: request.query.category } : {}),
        ...(request.query.minimumScore !== undefined
          ? { minimumScore: request.query.minimumScore }
          : {}),
        ...(request.query.maximumScore !== undefined
          ? { maximumScore: request.query.maximumScore }
          : {}),
        ...(request.query.negativeOnly !== undefined
          ? { negativeOnly: request.query.negativeOnly }
          : {}),
      });
      return {
        data: result.items.map(serializeSummary),
        pagination: { page, pageSize, total: result.total },
        meta: { timezone: result.timezone, dateBasis: 'SUBMITTED_AT' as const },
      };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['feedback review'],
        summary: 'Inspect one immutable feedback submission and its review history',
        params: idParamsSchema,
        response: { 200: Type.Object({ data: adminFeedbackDetailSchema }) },
      },
    },
    async (request) => ({
      data: serializeDetail(await options.adminFeedbackService.get(request.params.id)),
    }),
  );

  app.patch(
    '/:id/review-state',
    {
      schema: {
        tags: ['feedback review'],
        summary: 'Flag, unflag, or archive feedback without changing submitted answers',
        params: idParamsSchema,
        body: updateFeedbackReviewBodySchema,
        response: { 200: Type.Object({ data: adminFeedbackSummarySchema }) },
      },
    },
    async (request) => {
      await options.adminFeedbackService.updateReviewState(
        request.params.id,
        request.body.state,
        request.body.reason,
        request.auth!.accountId,
      );
      return {
        data: serializeSummaryFromDetail(await options.adminFeedbackService.get(request.params.id)),
      };
    },
  );
};

function serializeSummary(item: {
  id: string;
  tripId: string;
  bookingReference: string;
  respondentName: string;
  driverId: string;
  driverName: string;
  driverSource: 'AGENCY' | 'OUTSOURCED';
  vendorId: string | null;
  vendorName: string | null;
  submittedAt: Date;
  receivedAt: Date;
  submissionMode: 'ONLINE' | 'OFFLINE_SYNC';
  reviewState: 'NORMAL' | 'FLAGGED' | 'ARCHIVED';
  overallScore: number | null;
}) {
  return {
    id: item.id,
    tripId: item.tripId,
    bookingReference: item.bookingReference,
    respondentName: item.respondentName,
    driver: {
      id: item.driverId,
      displayName: item.driverName,
      sourceType: item.driverSource,
      vendorId: item.vendorId,
      vendorName: item.vendorName,
    },
    submittedAt: item.submittedAt.toISOString(),
    receivedAt: item.receivedAt.toISOString(),
    submissionMode: item.submissionMode,
    reviewState: item.reviewState,
    overallScore: item.overallScore,
  };
}

function serializeDetail(result: Awaited<ReturnType<AdminFeedbackService['get']>>) {
  const submission = result.submission;
  return {
    ...serializeSummaryFromDetail(result),
    respondent: {
      name: submission.respondentName,
      phone: result.respondentPhone,
      email: result.respondentEmail,
      bookingReference: submission.respondentBookingReference,
    },
    trip: {
      pickupLocation: result.trip.pickupLocation,
      destination: result.trip.destination,
      scheduledAt: result.trip.scheduledAt.toISOString(),
      scheduledEndAt: result.trip.scheduledEndAt.toISOString(),
      vehicle: result.trip.vehicleSnapshot,
    },
    consentVersionId: submission.consentVersionId,
    consentedAt: submission.consentedAt.toISOString(),
    questionnaireVersionId: submission.questionnaireVersionId,
    answers: result.answers.map((answer) => ({
      id: answer.id,
      questionId: answer.versionQuestionId,
      stableKey: answer.questionStableKey,
      prompt: answer.questionPromptSnapshot,
      questionType: answer.questionTypeSnapshot,
      category: answer.categorySnapshot,
      displayOrder: answer.displayOrderSnapshot,
      value: answer.answerPayload,
      numericScore: answer.numericScore,
    })),
    reviewHistory: result.history.map((event) => ({
      id: event.id,
      action: event.action,
      reason: event.reason,
      performedBy: {
        accountId: event.performedByAccountId,
        displayName: event.performedByDisplayName,
      },
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

function serializeSummaryFromDetail(result: Awaited<ReturnType<AdminFeedbackService['get']>>) {
  const submission = result.submission;
  return serializeSummary({
    id: submission.id,
    tripId: submission.tripId,
    bookingReference: submission.bookingReferenceSnapshot,
    respondentName: submission.respondentName,
    driverId: submission.driverId,
    driverName: submission.driverNameSnapshot,
    driverSource: submission.driverSourceSnapshot,
    vendorId: submission.vendorId,
    vendorName: submission.vendorNameSnapshot,
    submittedAt: submission.submittedAt,
    receivedAt: submission.receivedAt,
    submissionMode: submission.submissionMode,
    reviewState: submission.currentReviewState,
    overallScore: result.overallScore,
  });
}
