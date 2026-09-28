import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { CoreServices } from '../index.js';
import { paramsSchema, querySchema } from './masters.schemas.js';
import * as schemas from './billing.schemas.js';
/** JSON conversion handles nested timestamps; response schemas whitelist public fields. */
type Json<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;
function json<T>(value: T): Json<T> {
  return JSON.parse(JSON.stringify(value)) as Json<T>;
}
export const billingRoutes: FastifyPluginAsyncTypebox<{ services: CoreServices }> = async (
  app,
  { services },
) => {
  const billing = services.billing;
  app.get(
    '/invoices',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core billing'],
        querystring: Type.Omit(querySchema, ['status']),
        response: {
          200: Type.Object({
            data: Type.Array(schemas.invoiceResponse),
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
      const page = request.query.page ?? 1,
        pageSize = request.query.pageSize ?? 25;
      const result = await billing.list(page, pageSize);
      return json({ data: result.items, pagination: { page, pageSize, total: result.total } });
    },
  );
  app.get(
    '/invoices/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core billing'],
        params: paramsSchema,
        response: { 200: Type.Object({ data: schemas.invoiceDetailResponse }) },
      },
    },
    async (request) => json({ data: await billing.get(request.params.id) }),
  );
  app.post(
    '/invoices',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core billing'],
        body: schemas.invoiceBody,
        response: { 201: Type.Object({ data: schemas.invoiceDetailResponse }) },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(json({ data: await billing.createDraft(request.body, request.auth!.accountId) })),
  );
  app.put(
    '/invoices/:id',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core billing'],
        params: paramsSchema,
        body: schemas.invoiceUpdate,
        response: { 200: Type.Object({ data: schemas.invoiceDetailResponse }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return json({
        data: await billing.updateDraft(request.params.id, body, version, request.auth!.accountId),
      });
    },
  );
  app.post(
    '/invoices/:id/issue',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core billing'],
        params: paramsSchema,
        body: schemas.issueBody,
        response: { 200: Type.Object({ data: schemas.invoiceDetailResponse }) },
      },
    },
    async (request) =>
      json({
        data: await billing.issue(request.params.id, request.body.version, request.auth!.accountId),
      }),
  );
  app.post(
    '/invoices/:id/cancel',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core billing'],
        params: paramsSchema,
        body: schemas.reasonBody,
        response: { 200: Type.Object({ data: schemas.invoiceResponse }) },
      },
    },
    async (request) =>
      json({
        data: await billing.cancel(request.params.id, request.body.reason, request.auth!.accountId),
      }),
  );
  app.post(
    '/receipts',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core billing'],
        headers: schemas.idempotencyHeaders,
        body: schemas.receiptBody,
        response: { 201: Type.Object({ data: schemas.receiptResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        json({
          data: await billing.createReceipt(
            request.body,
            request.headers['idempotency-key'],
            request.auth!.accountId,
          ),
        }),
      ),
  );
  app.post(
    '/receipts/:id/confirm',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core billing'],
        params: paramsSchema,
        response: { 200: Type.Object({ data: schemas.receiptResponse }) },
      },
    },
    async (request) =>
      json({
        data: await billing.changeReceipt(
          request.params.id,
          'CONFIRMED',
          undefined,
          request.auth!.accountId,
        ),
      }),
  );
  app.post(
    '/receipts/:id/reverse',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core billing'],
        params: paramsSchema,
        body: schemas.reasonBody,
        response: { 200: Type.Object({ data: schemas.receiptResponse }) },
      },
    },
    async (request) =>
      json({
        data: await billing.changeReceipt(
          request.params.id,
          'REVERSED',
          request.body.reason,
          request.auth!.accountId,
        ),
      }),
  );
  app.post(
    '/settlement-adjustments',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core billing'],
        headers: schemas.idempotencyHeaders,
        body: schemas.adjustmentBody,
        response: { 201: Type.Object({ data: schemas.adjustmentResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        json({
          data: await billing.createAdjustment(
            request.body,
            request.headers['idempotency-key'],
            request.auth!.accountId,
          ),
        }),
      ),
  );
  app.post(
    '/settlement-adjustments/:id/reverse',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core billing'],
        params: paramsSchema,
        body: schemas.reasonBody,
        response: { 200: Type.Object({ data: schemas.adjustmentResponse }) },
      },
    },
    async (request) =>
      json({
        data: await billing.reverseAdjustment(
          request.params.id,
          request.body.reason,
          request.auth!.accountId,
        ),
      }),
  );
};
