import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { AuthGuards } from '../auth/auth.guard.js';
import type { TimelineActor, TimelineService } from './timeline.service.js';
import {
  bookingParams,
  pairParams,
  idParams,
  paging,
  overviewQuery,
  linkBody,
  createEventBody,
  photoBody,
  progressBody,
  linkResponse,
  contextResponse,
  eventsResponse,
  bookingsResponse,
  overviewResponse,
  progressResponse,
  photoUploadResponse,
  photoCompleteResponse,
  photoUrlResponse,
  receiptResponse,
} from './timeline.schemas.js';
interface Options {
  timelineService: TimelineService;
  guards: AuthGuards;
}
const tag = ['feedback timeline'];
export const adminTimelineRoutes: FastifyPluginAsyncTypebox<Options> = async (app, options) => {
  const service = options.timelineService;
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.addHook('preHandler', options.guards.admin);
  app.get(
    '/trips',
    {
      schema: {
        tags: tag,
        summary: 'Operational trip overview for the feedback dashboard',
        querystring: overviewQuery,
        response: { 200: overviewResponse },
      },
    },
    async (req) =>
      presentPromise(
        service.overview(req.query.page ?? 1, req.query.pageSize ?? 25, req.query.bookingId),
      ),
  );
  app.get(
    '/bookings/:bookingId/events',
    {
      schema: {
        tags: tag,
        summary: 'Combined booking timeline across drivers',
        params: bookingParams,
        querystring: paging,
        response: { 200: eventsResponse },
      },
    },
    async (req) =>
      presentPromise(
        service.timeline(
          req.params.bookingId,
          req.query.page ?? 1,
          req.query.pageSize ?? 25,
          undefined,
          req.query.tripId,
        ),
      ),
  );
  app.post(
    '/bookings/:bookingId/drivers/:driverId/link',
    {
      schema: {
        tags: tag,
        summary: 'Issue, refresh, extend or regenerate a booking-specific driver link',
        params: pairParams,
        body: linkBody,
        response: { 200: linkResponse },
      },
    },
    async (req) => ({
      data: await presentPromise(
        service.issueLink(req.params.bookingId, req.params.driverId, req.auth!.accountId, req.body),
      ),
    }),
  );
  app.delete(
    '/bookings/:bookingId/drivers/:driverId/link',
    { schema: { tags: tag, summary: 'Revoke booking-specific driver links', params: pairParams } },
    async (req, reply) => {
      await service.revokeLink(req.params.bookingId, req.params.driverId, req.auth!.accountId);
      return reply.status(204).send();
    },
  );
  app.patch(
    '/trips/:id/progress',
    {
      schema: {
        tags: tag,
        summary:
          'Override or reopen operational progress with an audited reason; invalidates old assignment grants',
        params: idParams,
        body: progressBody,
        response: { 200: progressResponse },
      },
    },
    async (req) => ({
      data: await presentPromise(
        service.setProgress(req.params.id, req.body.status, req.body.reason, req.auth!.accountId),
      ),
    }),
  );
  app.get(
    '/photos/:id/url',
    {
      schema: {
        tags: tag,
        summary: 'Private timeline photo download',
        params: idParams,
        response: { 200: photoUrlResponse },
      },
    },
    async (req) => ({ data: await presentPromise(service.photoUrl(req.params.id)) }),
  );
};

export const driverTimelineRoutes: FastifyPluginAsyncTypebox<Options> = async (app, options) => {
  const service = options.timelineService;
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.addHook('preHandler', options.guards.driver);
  const actor = (auth: { driverId: string | null; accountId: string }): TimelineActor => ({
    driverId: auth.driverId!,
    accountId: auth.accountId,
  });
  app.get(
    '/bookings',
    {
      schema: {
        tags: tag,
        summary: 'List bookings assigned to the logged-in driver',
        querystring: paging,
        response: { 200: bookingsResponse },
      },
    },
    async (req) =>
      presentPromise(
        service.driverBookings(
          req.auth!.driverId!,
          req.auth!.accountId,
          req.query.page ?? 1,
          req.query.pageSize ?? 25,
        ),
      ),
  );
  app.get(
    '/bookings/:bookingId/context',
    {
      schema: {
        tags: tag,
        summary: 'Driver-safe booking actions and current assignment versions',
        params: bookingParams,
        response: { 200: contextResponse },
      },
    },
    async (req) => ({
      data: await presentPromise(service.context(actor(req.auth!), req.params.bookingId)),
    }),
  );
  app.get(
    '/bookings/:bookingId/events',
    {
      schema: {
        tags: tag,
        summary: 'Driver own timeline updates for a booking',
        params: bookingParams,
        querystring: paging,
        response: { 200: eventsResponse },
      },
    },
    async (req) =>
      presentPromise(
        service.timeline(
          req.params.bookingId,
          req.query.page ?? 1,
          req.query.pageSize ?? 25,
          actor(req.auth!),
          req.query.tripId,
        ),
      ),
  );
  app.post(
    '/events',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: tag,
        summary: 'Record or retry a milestone, note or correction',
        body: createEventBody,
        response: { 200: receiptResponse, 201: receiptResponse },
      },
    },
    async (req, reply) => {
      const receipt = await service.submit(actor(req.auth!), req.body);
      return reply
        .status(receipt.replayed ? 200 : 201)
        .send({ data: { ...receipt, receivedAt: receipt.receivedAt.toISOString() } });
    },
  );
  app.post(
    '/photo-uploads',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: tag,
        summary: 'Create private milestone photo upload',
        body: photoBody,
        response: { 201: photoUploadResponse },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send({ data: await presentPromise(service.createPhoto(actor(req.auth!), req.body)) }),
  );
  app.post(
    '/photo-uploads/:id/complete',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: tag,
        summary: 'Verify and sanitize milestone photo',
        params: idParams,
        response: { 200: photoCompleteResponse },
      },
    },
    async (req) => ({
      data: await presentPromise(service.completePhoto(actor(req.auth!), req.params.id)),
    }),
  );
  app.get(
    '/photos/:id/url',
    {
      schema: {
        tags: tag,
        summary: 'Private driver timeline photo download',
        params: idParams,
        response: { 200: photoUrlResponse },
      },
    },
    async (req) => ({
      data: await presentPromise(service.photoUrl(req.params.id, actor(req.auth!))),
    }),
  );
};

export const linkTimelineRoutes: FastifyPluginAsyncTypebox<
  Pick<Options, 'timelineService'>
> = async (app, options) => {
  const service = options.timelineService;
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  const actor = (authorization: string | undefined): TimelineActor => ({
    token: authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '',
  });
  app.get(
    '/context',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: tag,
        summary: 'Open driver booking link without login',
        response: { 200: contextResponse },
      },
    },
    async (req) => ({
      data: await presentPromise(service.context(actor(req.headers.authorization))),
    }),
  );
  app.get(
    '/bookings/:bookingId/events',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: tag,
        summary: 'Own updates authorised by a driver booking link',
        params: bookingParams,
        querystring: paging,
        response: { 200: eventsResponse },
      },
    },
    async (req) =>
      presentPromise(
        service.timeline(
          req.params.bookingId,
          req.query.page ?? 1,
          req.query.pageSize ?? 25,
          actor(req.headers.authorization),
          req.query.tripId,
        ),
      ),
  );
  app.post(
    '/events',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: tag,
        summary: 'Record milestone through a booking-specific driver link',
        body: createEventBody,
        response: { 200: receiptResponse, 201: receiptResponse },
      },
    },
    async (req, reply) => {
      const receipt = await service.submit(actor(req.headers.authorization), req.body);
      return reply
        .status(receipt.replayed ? 200 : 201)
        .send({ data: { ...receipt, receivedAt: receipt.receivedAt.toISOString() } });
    },
  );
  app.post(
    '/photo-uploads',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: tag,
        summary: 'Create link-authorised milestone photo upload',
        body: photoBody,
        response: { 201: photoUploadResponse },
      },
    },
    async (req, reply) =>
      reply.status(201).send({
        data: await presentPromise(service.createPhoto(actor(req.headers.authorization), req.body)),
      }),
  );
  app.post(
    '/photo-uploads/:id/complete',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: tag,
        summary: 'Complete link-authorised milestone photo upload',
        params: idParams,
        response: { 200: photoCompleteResponse },
      },
    },
    async (req) => ({
      data: await presentPromise(
        service.completePhoto(actor(req.headers.authorization), req.params.id),
      ),
    }),
  );
  app.get(
    '/photos/:id/url',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: tag,
        summary: 'Download own link-authorised timeline photo',
        params: idParams,
        response: { 200: photoUrlResponse },
      },
    },
    async (req) => ({
      data: await presentPromise(service.photoUrl(req.params.id, actor(req.headers.authorization))),
    }),
  );
};

type JsonDates<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? JsonDates<U>[]
    : T extends object
      ? { [K in keyof T]: JsonDates<T[K]> }
      : T;
async function presentPromise<T>(value: Promise<T>): Promise<JsonDates<T>> {
  return JSON.parse(JSON.stringify(await value)) as JsonDates<T>;
}
