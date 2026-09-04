import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { AuthGuards } from '../auth/auth.guard.js';
import type { BookingService } from '../bookings/booking.service.js';
import {
  adminFeedbackShareResponseSchema,
  feedbackLinkResponseSchema,
  handoffResponseSchema,
} from '../feedback/feedback.schemas.js';
import type { FeedbackService } from '../feedback/feedback.service.js';
import { idParamsSchema } from '../vendors/vendor.schemas.js';
import { presentEngagement } from './engagement.presenter.js';
import {
  driverEngagementListQuerySchema,
  engagementListQuerySchema,
  engagementListResponseSchema,
  engagementResponseSchema,
  updateEngagementFeedbackSectionsBodySchema,
} from './engagement.schemas.js';
import type { EngagementService } from './engagement.service.js';

interface CommonOptions {
  readonly guards: AuthGuards;
  readonly engagementService: EngagementService;
  readonly feedbackService: FeedbackService;
}

export const adminEngagementRoutes: FastifyPluginAsyncTypebox<
  CommonOptions & { readonly bookingService: BookingService }
> = async (app, options) => {
  app.addHook('preHandler', options.guards.admin);

  app.get(
    '/',
    {
      schema: {
        tags: ['engagements'],
        summary: 'List derived driver engagements',
        querystring: engagementListQuerySchema,
        response: { 200: engagementListResponseSchema },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 25;
      const result = await options.engagementService.list({
        page,
        pageSize,
        ...(request.query.bookingId ? { bookingId: request.query.bookingId } : {}),
        ...(request.query.status ? { status: request.query.status } : {}),
      });
      return {
        data: result.items.map(presentEngagement),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['engagements'],
        summary: 'Get one derived driver engagement',
        params: idParamsSchema,
        response: { 200: engagementResponseSchema },
      },
    },
    async (request) => ({
      data: presentEngagement(await options.engagementService.get(request.params.id)),
    }),
  );

  app.patch(
    '/:id/feedback-sections',
    {
      schema: {
        tags: ['engagements'],
        summary: 'Update feedback sections for a ready engagement',
        params: idParamsSchema,
        body: updateEngagementFeedbackSectionsBodySchema,
        response: { 200: engagementResponseSchema },
      },
    },
    async (request) => ({
      data: presentEngagement(
        await options.engagementService.updateFeedbackSections(
          request.params.id,
          request.body.feedbackPurposes,
          request.auth!.accountId,
        ),
      ),
    }),
  );

  app.get(
    '/:id/feedback-link',
    {
      schema: {
        tags: ['engagements'],
        summary: 'Get the shareable passenger feedback link for an engagement',
        params: idParamsSchema,
        response: { 200: adminFeedbackShareResponseSchema },
      },
    },
    async (request) => {
      const engagement = await options.engagementService.get(request.params.id);
      const [handoff, booking] = await Promise.all([
        options.feedbackService.issueHandoff(engagement.id),
        options.bookingService.get(engagement.bookingId),
      ]);
      return {
        data: {
          ...presentFeedbackLink(handoff),
          recipient: { name: booking.passengerName, phone: booking.passengerPhone },
        },
      };
    },
  );
};

export const driverEngagementRoutes: FastifyPluginAsyncTypebox<CommonOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.driver);

  app.get(
    '/',
    {
      schema: {
        tags: ['driver engagements'],
        summary: 'List engagements assigned to the authenticated driver',
        querystring: driverEngagementListQuerySchema,
        response: { 200: engagementListResponseSchema },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 25;
      const result = await options.engagementService.list({
        page,
        pageSize,
        driverId: request.auth!.driverId!,
        ...(request.query.status ? { status: request.query.status } : {}),
      });
      return {
        data: result.items.map(presentEngagement),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['driver engagements'],
        summary: 'Get an engagement assigned to the authenticated driver',
        params: idParamsSchema,
        response: { 200: engagementResponseSchema },
      },
    },
    async (request) => ({
      data: presentEngagement(
        await options.engagementService.get(request.params.id, request.auth!.driverId!),
      ),
    }),
  );

  app.post(
    '/:id/start-feedback',
    {
      schema: {
        tags: ['driver engagements'],
        summary: 'Prepare an assigned engagement for passenger feedback',
        params: idParamsSchema,
        response: { 200: handoffResponseSchema },
      },
    },
    async (request) => {
      const engagement = await options.engagementService.get(
        request.params.id,
        request.auth!.driverId!,
      );
      const handoff = await options.feedbackService.issueHandoff(engagement.id);
      return {
        data: {
          ...presentEngagement(engagement),
          feedbackAccessToken: handoff.token,
          feedbackAccessTokenExpiresAt: handoff.expiresAt.toISOString(),
          feedbackLink: handoff.link,
        },
      };
    },
  );

  app.get(
    '/:id/feedback-link',
    {
      schema: {
        tags: ['driver engagements'],
        summary: 'Get the passenger feedback link for an assigned engagement',
        params: idParamsSchema,
        response: { 200: feedbackLinkResponseSchema },
      },
    },
    async (request) => {
      const engagement = await options.engagementService.get(
        request.params.id,
        request.auth!.driverId!,
      );
      return {
        data: presentFeedbackLink(await options.feedbackService.issueHandoff(engagement.id)),
      };
    },
  );
};

function presentFeedbackLink(handoff: Awaited<ReturnType<FeedbackService['issueHandoff']>>) {
  return {
    engagementId: handoff.engagementId,
    feedbackLink: handoff.link,
    feedbackAccessTokenExpiresAt: handoff.expiresAt.toISOString(),
  };
}
