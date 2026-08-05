import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { AuthGuards } from '../auth/auth.guard.js';
import { presentTrip } from '../trips/trip.presenter.js';
import type { TripService } from '../trips/trip.service.js';
import {
  bookingDetailResponseSchema,
  bookingListQuerySchema,
  bookingListResponseSchema,
  bookingResponseSchema,
  createBookingBodySchema,
  idParamsSchema,
  updateBookingBodySchema,
} from './booking.schemas.js';
import { presentBooking } from './booking.presenter.js';
import type { BookingService } from './booking.service.js';

export const bookingRoutes: FastifyPluginAsyncTypebox<{
  readonly guards: AuthGuards;
  readonly bookingService: BookingService;
  readonly tripService: TripService;
}> = async (app, options) => {
  app.addHook('preHandler', options.guards.admin);

  app.post(
    '/',
    {
      schema: {
        tags: ['bookings'],
        summary: 'Create a booking',
        body: createBookingBodySchema,
        response: { 201: bookingResponseSchema },
      },
    },
    async (request, reply) =>
      reply.status(201).send({
        data: presentBooking(
          await options.bookingService.create(request.body, request.auth!.accountId),
        ),
      }),
  );
  app.get(
    '/',
    {
      schema: {
        tags: ['bookings'],
        summary: 'List bookings',
        querystring: bookingListQuerySchema,
        response: { 200: bookingListResponseSchema },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 25;
      const result = await options.bookingService.list({
        page,
        pageSize,
        ...(request.query.status ? { status: request.query.status } : {}),
      });
      return {
        data: result.items.map(presentBooking),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/:id',
    {
      schema: {
        tags: ['bookings'],
        summary: 'Get a booking',
        params: idParamsSchema,
        response: { 200: bookingDetailResponseSchema },
      },
    },
    async (request) => {
      const [booking, trips] = await Promise.all([
        options.bookingService.get(request.params.id),
        options.tripService.listForBooking(request.params.id),
      ]);
      return { data: { ...presentBooking(booking), trips: trips.map(presentTrip) } };
    },
  );
  app.patch(
    '/:id',
    {
      schema: {
        tags: ['bookings'],
        summary: 'Update a booking',
        params: idParamsSchema,
        body: updateBookingBodySchema,
        response: { 200: bookingResponseSchema },
      },
    },
    async (request) => ({
      data: presentBooking(
        await options.bookingService.update(
          request.params.id,
          request.body,
          request.auth!.accountId,
        ),
      ),
    }),
  );
  app.post(
    '/:id/archive',
    {
      schema: {
        tags: ['bookings'],
        summary: 'Archive a booking',
        params: idParamsSchema,
        response: { 200: bookingResponseSchema },
      },
    },
    async (request) => ({
      data: presentBooking(
        await options.bookingService.archive(request.params.id, request.auth!.accountId),
      ),
    }),
  );
};
