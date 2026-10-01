import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { CoreServices } from '../index.js';
import { dateSchema, moneySchema, nonblank, paramsSchema, uuidSchema } from './masters.schemas.js';
import { AppError } from '../../../shared/errors/app-error.js';

const bookingBody = Type.Object(
  {
    reference: nonblank,
    companyId: uuidSchema,
    customerId: uuidSchema,
    serviceCategoryId: uuidSchema,
    title: nonblank,
    serviceStartsOn: Type.Optional(Type.Union([dateSchema, Type.Null()])),
    serviceEndsOn: Type.Optional(Type.Union([dateSchema, Type.Null()])),
  },
  { additionalProperties: false },
);
const quoteBody = Type.Object(
  {
    description: Type.String({ minLength: 1, maxLength: 20000, pattern: '\\S' }),
    inclusions: Type.String({ maxLength: 20000 }),
    exclusions: Type.String({ maxLength: 20000 }),
    terms: Type.String({ minLength: 1, maxLength: 20000, pattern: '\\S' }),
    total: moneySchema,
    expiresOn: Type.Optional(Type.Union([dateSchema, Type.Null()])),
  },
  { additionalProperties: false },
);
const scheduleBody = Type.Object(
  {
    milestones: Type.Optional(
      Type.Array(
        Type.Object(
          { label: nonblank, amount: moneySchema, dueOn: dateSchema },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 12 },
      ),
    ),
  },
  { additionalProperties: false },
);
const tokenParams = Type.Object({
  token: Type.String({ minLength: 40, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$' }),
});
const tokenMilestoneParams = Type.Object({ ...tokenParams.properties, milestoneId: uuidSchema });
const orderParams = Type.Object({ orderId: Type.String({ pattern: '^er_[a-f0-9]{32}$' }) });
const tokenOrderParams = Type.Object({ ...tokenParams.properties, ...orderParams.properties });
const data = Type.Object({ data: Type.Any() });
const nullableString = Type.Union([Type.String(), Type.Null()]);
const publicBookingResponse = Type.Object({
  data: Type.Object({
    reference: Type.String(),
    title: Type.String(),
    status: Type.String(),
    serviceStartsOn: nullableString,
    serviceEndsOn: nullableString,
    quote: Type.Union([
      Type.Object({
        version: Type.Integer(),
        description: Type.String(),
        inclusions: Type.String(),
        exclusions: Type.String(),
        terms: Type.String(),
        total: moneySchema,
        currency: Type.Literal('INR'),
        expiresOn: nullableString,
        acceptedAt: nullableString,
      }),
      Type.Null(),
    ]),
    invoice: Type.Union([
      Type.Object({
        number: nullableString,
        date: dateSchema,
        total: moneySchema,
        received: moneySchema,
        due: moneySchema,
        paymentStatus: Type.String(),
      }),
      Type.Null(),
    ]),
    paymentReviewRequired: Type.Boolean(),
    payments: Type.Array(
      Type.Object({
        number: Type.String(),
        date: dateSchema,
        amount: moneySchema,
        method: Type.String(),
      }),
    ),
    milestones: Type.Array(
      Type.Object({
        id: uuidSchema,
        position: Type.Integer(),
        label: Type.String(),
        amount: moneySchema,
        dueOn: dateSchema,
        paid: Type.Boolean(),
        remaining: moneySchema,
        remainingAmount: moneySchema,
        status: Type.Union([
          Type.Literal('PENDING'),
          Type.Literal('PARTIALLY_PAID'),
          Type.Literal('PAID'),
        ]),
      }),
    ),
  }),
});
const policyBody = Type.Object(
  {
    initialPercent: Type.Integer({ minimum: 1, maximum: 99 }),
    balanceDaysBefore: Type.Integer({ minimum: 1, maximum: 365 }),
    fullPaymentWithinDays: Type.Integer({ minimum: 0, maximum: 365 }),
  },
  { additionalProperties: false },
);
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const commercialRoutes: FastifyPluginAsyncTypebox<{ services: CoreServices }> = async (
  app,
  { services },
) => {
  const commercial = services.commercial;
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/v1/core/public/')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
    }
  });
  app.get(
    '/companies/:id/payment-policy',
    {
      preHandler: services.guards.read,
      schema: { tags: ['core commercial'], params: paramsSchema, response: { 200: data } },
    },
    async (request) => ({ data: await commercial.getPolicy(request.params.id) }),
  );
  app.put(
    '/companies/:id/payment-policy',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core commercial'],
        params: paramsSchema,
        body: policyBody,
        response: { 200: data },
      },
    },
    async (request) => ({
      data: await commercial.setPolicy(request.params.id, request.body, request.auth!.accountId),
    }),
  );
  app.post(
    '/commercial-bookings',
    {
      preHandler: services.guards.write,
      schema: { tags: ['core commercial'], body: bookingBody, response: { 201: data } },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(asJson({ data: await commercial.create(request.body, request.auth!.accountId) })),
  );
  app.get(
    '/commercial-bookings',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core commercial'],
        querystring: Type.Object({
          page: Type.Optional(Type.Integer({ minimum: 1 })),
          pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        }),
        response: { 200: data },
      },
    },
    async (request) => ({
      data: await commercial.list(request.query.page ?? 1, request.query.pageSize ?? 25),
    }),
  );
  app.get(
    '/commercial-bookings/:id',
    {
      preHandler: services.guards.read,
      schema: { tags: ['core commercial'], params: paramsSchema, response: { 200: data } },
    },
    async (request) => asJson({ data: await commercial.get(request.params.id) }),
  );
  app.get(
    '/commercial-bookings/:id/available-invoices',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core commercial'],
        params: paramsSchema,
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 80 })),
          page: Type.Optional(Type.Integer({ minimum: 1 })),
          pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        }),
        response: {
          200: Type.Object({
            data: Type.Array(
              Type.Object({
                id: uuidSchema,
                invoiceNumber: nullableString,
                financialYear: nullableString,
                invoiceDate: dateSchema,
                status: Type.String(),
                grandTotal: moneySchema,
                customerName: Type.String(),
                guestName: Type.String(),
                label: nullableString,
                lineDescription: nullableString,
                eligible: Type.Boolean(),
                unavailableReasons: Type.Array(Type.String()),
              }),
            ),
            pagination: Type.Object({
              page: Type.Integer(),
              pageSize: Type.Integer(),
              total: Type.Integer(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 25;
      const result = await commercial.availableInvoices(
        request.params.id,
        request.query.q,
        page,
        pageSize,
      );
      return { data: result.items, pagination: { page, pageSize, total: result.total } };
    },
  );
  app.post(
    '/commercial-bookings/:id/rotate-link',
    {
      preHandler: services.guards.write,
      schema: { tags: ['core commercial'], params: paramsSchema, response: { 200: data } },
    },
    async (request) => ({
      data: await commercial.rotateAccessToken(request.params.id, request.auth!.accountId),
    }),
  );
  app.post(
    '/commercial-bookings/:id/quotes',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core commercial'],
        params: paramsSchema,
        body: quoteBody,
        response: { 201: data },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        asJson({
          data: await commercial.addQuote(request.params.id, request.body, request.auth!.accountId),
        }),
      ),
  );
  app.post(
    '/commercial-bookings/:id/invoice',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core commercial'],
        params: paramsSchema,
        body: Type.Union([
          Type.Object({ invoiceId: uuidSchema }, { additionalProperties: false }),
          Type.Object(
            {
              invoiceNumber: Type.String({ minLength: 1, maxLength: 80, pattern: '\\S' }),
              financialYear: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
            },
            { additionalProperties: false },
          ),
        ]),
        response: { 200: data },
      },
    },
    async (request) =>
      asJson({
        data: await commercial.attachInvoice(
          request.params.id,
          request.body,
          request.auth!.accountId,
        ),
      }),
  );
  app.post(
    '/commercial-bookings/:id/schedule',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core commercial'],
        params: paramsSchema,
        body: scheduleBody,
        response: { 201: data },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        asJson({
          data: await commercial.setSchedule(
            request.params.id,
            request.body.milestones,
            request.auth!.accountId,
          ),
        }),
      ),
  );
  app.post(
    '/commercial-bookings/:id/status',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core commercial'],
        params: paramsSchema,
        body: Type.Object({
          status: Type.Union([
            Type.Literal('CONFIRMED'),
            Type.Literal('CANCELLED'),
            Type.Literal('COMPLETED'),
          ]),
        }),
        response: { 200: data },
      },
    },
    async (request) =>
      asJson({
        data: await commercial.changeStatus(
          request.params.id,
          request.body.status,
          request.auth!.accountId,
        ),
      }),
  );
  app.get(
    '/public/bookings/:token',
    {
      schema: {
        tags: ['core commercial'],
        params: tokenParams,
        response: { 200: publicBookingResponse },
      },
    },
    async (request) => asJson({ data: await commercial.publicDetail(request.params.token) }),
  );
  app.post(
    '/public/bookings/:token/accept',
    {
      schema: { tags: ['core commercial'], params: tokenParams, response: { 200: data } },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => asJson({ data: await commercial.acceptQuote(request.params.token) }),
  );
  app.post(
    '/public/bookings/:token/milestones/:milestoneId/checkout',
    {
      schema: { tags: ['core commercial'], params: tokenMilestoneParams, response: { 200: data } },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) =>
      asJson({ data: await commercial.checkout(request.params.token, request.params.milestoneId) }),
  );
  app.post(
    '/payment-orders/:orderId/reconcile',
    {
      preHandler: services.guards.write,
      schema: { tags: ['core commercial'], params: orderParams, response: { 200: data } },
    },
    async (request) => asJson({ data: await commercial.reconcile(request.params.orderId) }),
  );
  app.post(
    '/public/bookings/:token/orders/:orderId/reconcile',
    {
      schema: { tags: ['core commercial'], params: tokenOrderParams, response: { 200: data } },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) =>
      asJson({
        data: await commercial.reconcileForToken(request.params.token, request.params.orderId),
      }),
  );

  await app.register(async (webhooks) => {
    webhooks.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
    webhooks.post(
      '/payments/webhooks/cashfree',
      {
        config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
        schema: {
          tags: ['core commercial'],
          response: { 200: Type.Object({ received: Type.Boolean() }) },
        },
      },
      async (request) => {
        const provider = services.paymentProvider;
        if (!provider || provider.name !== 'cashfree')
          throw new AppError({
            code: 'PAYMENTS_UNAVAILABLE',
            message: 'Online payments are not configured',
            statusCode: 503,
          });
        const body = request.body;
        const signature = request.headers['x-webhook-signature'];
        const timestamp = request.headers['x-webhook-timestamp'];
        if (
          !Buffer.isBuffer(body) ||
          typeof signature !== 'string' ||
          typeof timestamp !== 'string' ||
          !provider.verifyWebhook(body, signature, timestamp)
        ) {
          throw new AppError({
            code: 'INVALID_WEBHOOK_SIGNATURE',
            message: 'Invalid payment notification',
            statusCode: 401,
          });
        }
        let event: unknown;
        try {
          event = JSON.parse(body.toString('utf8'));
        } catch {
          throw new AppError({
            code: 'INVALID_WEBHOOK',
            message: 'Invalid payment notification',
            statusCode: 400,
          });
        }
        const orderId = (event as { data?: { order?: { order_id?: unknown } } }).data?.order
          ?.order_id;
        if (typeof orderId !== 'string' || !/^er_[a-f0-9]{32}$/.test(orderId))
          throw new AppError({
            code: 'INVALID_WEBHOOK',
            message: 'Invalid payment notification',
            statusCode: 400,
          });
        await commercial.reconcile(orderId);
        return { received: true };
      },
    );
  });
};
