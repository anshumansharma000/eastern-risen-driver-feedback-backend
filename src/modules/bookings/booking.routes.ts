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
      return {
        data: {
          ...presentBooking(booking),
          tripCount: trips.length,
          trips: trips.map(presentTrip),
          feedbackWarnings: feedbackConfigurationWarnings(trips),
        },
      };
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

function feedbackConfigurationWarnings(trips: Awaited<ReturnType<TripService['listForBooking']>>) {
  const activeTrips = trips.filter((trip) => trip.status !== 'ARCHIVED');
  const firstTrip = activeTrips[0];
  const lastTrip = activeTrips.at(-1);
  const arrivalTrip = activeTrips.find((trip) =>
    trip.feedbackPurposes.includes('ARRIVAL_EXPERIENCE'),
  );
  const tourTrip = activeTrips.find((trip) => trip.feedbackPurposes.includes('TOUR_EXPERIENCE'));
  const warnings: Array<{
    code:
      | 'ARRIVAL_FEEDBACK_MISSING'
      | 'ARRIVAL_FEEDBACK_NOT_ON_FIRST_TRIP'
      | 'TOUR_FEEDBACK_MISSING'
      | 'TOUR_FEEDBACK_NOT_ON_LAST_TRIP';
    message: string;
    tripId: string | null;
  }> = [];
  if (!arrivalTrip) {
    warnings.push({
      code: 'ARRIVAL_FEEDBACK_MISSING',
      message: 'Assign arrival and booking feedback to the first pickup trip',
      tripId: null,
    });
  } else if (firstTrip && arrivalTrip.id !== firstTrip.id) {
    warnings.push({
      code: 'ARRIVAL_FEEDBACK_NOT_ON_FIRST_TRIP',
      message: 'Arrival and booking feedback is not assigned to the earliest scheduled trip',
      tripId: arrivalTrip.id,
    });
  }
  if (!tourTrip) {
    warnings.push({
      code: 'TOUR_FEEDBACK_MISSING',
      message: 'Assign tour coordination and experience feedback to the final trip',
      tripId: null,
    });
  } else if (lastTrip && tourTrip.id !== lastTrip.id) {
    warnings.push({
      code: 'TOUR_FEEDBACK_NOT_ON_LAST_TRIP',
      message: 'Tour coordination and experience feedback is not assigned to the last trip',
      tripId: tourTrip.id,
    });
  }
  return warnings;
}
