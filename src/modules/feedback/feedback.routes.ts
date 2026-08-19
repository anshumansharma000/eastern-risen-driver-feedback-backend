import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { FeedbackService } from './feedback.service.js';
import {
  completedPhotoResponseSchema,
  createPhotoUploadBodySchema,
  passengerContextResponseSchema,
  photoUploadResponseSchema,
  startFeedbackResponseSchema,
  submissionReceiptSchema,
  submitFeedbackBodySchema,
} from './feedback.schemas.js';

export interface FeedbackRouteOptions {
  readonly feedbackService: FeedbackService;
}

export const feedbackRoutes: FastifyPluginAsyncTypebox<FeedbackRouteOptions> = async (
  app,
  options,
) => {
  app.get(
    '/context',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['passenger feedback'],
        summary: 'Load passenger-safe trip, questionnaire, and consent context',
        response: { 200: passengerContextResponseSchema },
      },
    },
    async (request) => {
      const context = await options.feedbackService.getContext(
        bearerToken(request.headers.authorization),
      );
      return {
        data: {
          trip: {
            id: context.trip.id,
            bookingReference: context.trip.bookingReference,
            pickupLocation: context.trip.pickupLocation,
            destination: context.trip.destination,
            scheduledAt: context.trip.scheduledAt.toISOString(),
            vehicle: context.trip.vehicleSnapshot,
            driver: { displayName: context.trip.driverNameSnapshot },
          },
          questionnaire: context.snapshot,
          consent: {
            id: context.consent.id,
            version: context.consent.version,
            content: context.consent.content,
            effectiveAt: context.consent.effectiveAt.toISOString(),
            retiredAt: context.consent.retiredAt?.toISOString() ?? null,
          },
          completion: {
            agencyName: context.settings.agencyName,
            timezone: context.settings.timezone,
            thankYouMessage: context.settings.defaultThankYouMessage,
          },
        },
      };
    },
  );

  app.post(
    '/start',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['passenger feedback'],
        summary: 'Begin passenger feedback after the introductory phase',
        response: { 200: startFeedbackResponseSchema },
      },
    },
    async (request) => {
      const result = await options.feedbackService.start(
        bearerToken(request.headers.authorization),
      );
      return {
        data: {
          tripId: result.tripId,
          status: result.status,
          startedFeedbackAt: result.startedFeedbackAt.toISOString(),
        },
      };
    },
  );

  app.post(
    '/photo-uploads',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['passenger feedback'],
        summary: 'Create a short-lived direct upload URL for an optional feedback photo',
        body: createPhotoUploadBodySchema,
        response: { 201: photoUploadResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await options.feedbackService.createPhotoUpload(
        bearerToken(request.headers.authorization),
        request.body,
      );
      return reply.status(201).send({
        data: {
          id: result.id,
          uploadUrl: result.uploadUrl,
          method: 'PUT' as const,
          headers: { 'Content-Type': result.contentType },
          expiresAt: result.expiresAt.toISOString(),
          maxBytes: result.maxBytes,
        },
      });
    },
  );

  app.post(
    '/photo-uploads/:id/complete',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['passenger feedback'],
        summary: 'Verify and sanitize a directly uploaded optional feedback photo',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: completedPhotoResponseSchema },
      },
    },
    async (request) => {
      const result = await options.feedbackService.completePhotoUpload(
        bearerToken(request.headers.authorization),
        request.params.id,
      );
      return {
        data: {
          ...result,
          completedAt: result.completedAt.toISOString(),
        },
      };
    },
  );

  app.post(
    '/submissions',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['passenger feedback'],
        summary: 'Submit or idempotently synchronize passenger feedback',
        body: submitFeedbackBodySchema,
        response: { 201: submissionReceiptSchema, 200: submissionReceiptSchema },
      },
    },
    async (request, reply) => {
      const result = await options.feedbackService.submit(
        bearerToken(request.headers.authorization),
        request.body,
      );
      return reply.status(result.replayed ? 200 : 201).send({
        data: {
          ...result,
          receivedAt: result.receivedAt.toISOString(),
        },
      });
    },
  );
};

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ')) return '';
  return authorization.slice(7).trim();
}
