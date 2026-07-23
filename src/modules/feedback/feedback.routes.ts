import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FeedbackService } from './feedback.service.js';
import {
  passengerContextResponseSchema,
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
