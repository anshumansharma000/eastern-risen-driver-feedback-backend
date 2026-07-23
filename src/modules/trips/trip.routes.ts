import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { AuthGuards } from '../auth/auth.guard.js';
import { handoffResponseSchema } from '../feedback/feedback.schemas.js';
import type { FeedbackService } from '../feedback/feedback.service.js';
import {
  createAdminTripBodySchema,
  createDriverTripBodySchema,
  driverTripListQuerySchema,
  idParamsSchema,
  tripListQuerySchema,
  tripListResponseSchema,
  tripResponseSchema,
  updateAdminTripBodySchema,
} from './trip.schemas.js';
import type { TripService } from './trip.service.js';
import { presentTrip } from './trip.presenter.js';

export interface AdminTripRouteOptions {
  readonly guards: AuthGuards;
  readonly tripService: TripService;
}

export interface DriverTripRouteOptions extends AdminTripRouteOptions {
  readonly feedbackService: FeedbackService;
}

export const adminTripRoutes: FastifyPluginAsyncTypebox<AdminTripRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.admin);

  app.post(
    '/',
    {
      schema: {
        tags: ['trips'],
        summary: 'Create and assign a trip',
        body: createAdminTripBodySchema,
        response: { 201: tripResponseSchema },
      },
    },
    async (request, reply) => {
      const trip = await options.tripService.createAdmin(request.body, request.auth!.accountId);
      return reply.status(201).send({ data: presentTrip(trip) });
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['trips'],
        summary: 'List trips for administrators',
        querystring: tripListQuerySchema,
        response: { 200: tripListResponseSchema },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 25;
      const result = await options.tripService.list({
        page,
        pageSize,
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.driverId ? { driverId: request.query.driverId } : {}),
        ...(request.query.creationSource ? { creationSource: request.query.creationSource } : {}),
      });
      return {
        data: result.items.map(presentTrip),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['trips'],
        summary: 'Get a trip as an administrator',
        params: idParamsSchema,
        response: { 200: tripResponseSchema },
      },
    },
    async (request) => ({ data: presentTrip(await options.tripService.get(request.params.id)) }),
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['trips'],
        summary: 'Edit a ready trip',
        params: idParamsSchema,
        body: updateAdminTripBodySchema,
        response: { 200: tripResponseSchema },
      },
    },
    async (request) => ({
      data: presentTrip(
        await options.tripService.update(request.params.id, request.body, request.auth!.accountId),
      ),
    }),
  );

  app.post(
    '/:id/archive',
    {
      schema: {
        tags: ['trips'],
        summary: 'Archive a trip while retaining its history',
        params: idParamsSchema,
        response: { 200: tripResponseSchema },
      },
    },
    async (request) => ({
      data: presentTrip(
        await options.tripService.archive(request.params.id, request.auth!.accountId),
      ),
    }),
  );
};

export const driverTripRoutes: FastifyPluginAsyncTypebox<DriverTripRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.driver);

  app.post(
    '/',
    {
      schema: {
        tags: ['driver trips'],
        summary: 'Create a trip assigned to the authenticated driver',
        body: createDriverTripBodySchema,
        response: { 201: tripResponseSchema },
      },
    },
    async (request, reply) => {
      const trip = await options.tripService.createDriver(
        request.body,
        request.auth!.driverId!,
        request.auth!.accountId,
      );
      return reply.status(201).send({ data: presentTrip(trip) });
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['driver trips'],
        summary: 'List trips assigned to the authenticated driver',
        querystring: driverTripListQuerySchema,
        response: { 200: tripListResponseSchema },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 25;
      const result = await options.tripService.list({
        page,
        pageSize,
        driverId: request.auth!.driverId!,
        ...(request.query.status ? { status: request.query.status } : {}),
      });
      return {
        data: result.items.map(presentTrip),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['driver trips'],
        summary: 'Get one trip assigned to the authenticated driver',
        params: idParamsSchema,
        response: { 200: tripResponseSchema },
      },
    },
    async (request) => ({
      data: presentTrip(await options.tripService.get(request.params.id, request.auth!.driverId!)),
    }),
  );

  app.post(
    '/:id/start-feedback',
    {
      schema: {
        tags: ['driver trips'],
        summary: 'Mark an assigned trip ready for the passenger feedback handoff',
        params: idParamsSchema,
        response: { 200: handoffResponseSchema },
      },
    },
    async (request) => {
      const trip = await options.tripService.startFeedback(
        request.params.id,
        request.auth!.driverId!,
        request.auth!.accountId,
      );
      const handoff = await options.feedbackService.issueHandoff(trip.id);
      return {
        data: {
          ...presentTrip(trip),
          feedbackAccessToken: handoff.token,
          feedbackAccessTokenExpiresAt: handoff.expiresAt.toISOString(),
        },
      };
    },
  );
};
