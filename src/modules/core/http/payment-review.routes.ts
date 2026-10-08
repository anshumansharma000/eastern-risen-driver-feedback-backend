import type { ResolutionInput } from '../application/payment-review.contracts.js';
import { invalid } from '../domain/errors.js';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { CoreServices } from '../index.js';
import { uuidSchema, moneySchema } from './masters.schemas.js';
import { idempotencyHeaders } from './billing.schemas.js';
const orderParams = Type.Object({ orderId: uuidSchema }, { additionalProperties: false });
const note = Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' });
const base = { version: Type.String({ pattern: '^[a-f0-9]{64}$' }), note };
const resolutionBody = Type.Object(
  {
    ...base,
    action: Type.Union([
      Type.Literal('APPLY_TO_LINKED_INVOICE'),
      Type.Literal('LINK_EXISTING_RECEIPT'),
      Type.Literal('RECORD_VERIFIED_EXTERNAL_REFUND'),
    ]),
    receiptId: Type.Optional(uuidSchema),
    refund: Type.Optional(
      Type.Object(
        {
          providerRefundReference: Type.String({
            minLength: 1,
            maxLength: 200,
            pattern: '^\\S(?:.*\\S)?$',
          }),
          amount: moneySchema,
          currency: Type.String({ pattern: '^[A-Z]{3}$' }),
          completedAt: Type.String({ format: 'date-time' }),
          verification: Type.Object(
            {
              kind: Type.Literal('STAFF_ATTESTATION'),
              evidenceReference: Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }),
              attested: Type.Literal(true),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const data = Type.Object({ data: Type.Any() });
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const paymentReviewRoutes: FastifyPluginAsyncTypebox<{ services: CoreServices }> = async (
  app,
  { services },
) => {
  app.get(
    '/payment-orders/:orderId/review',
    {
      preHandler: services.guards.read,
      schema: { tags: ['core payments review'], params: orderParams, response: { 200: data } },
    },
    async (request) => json({ data: await services.paymentReview.inspect(request.params.orderId) }),
  );
  app.post(
    '/payment-attempts/:attemptId/resolve',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core payments review'],
        params: Type.Object({ attemptId: uuidSchema }),
        headers: idempotencyHeaders,
        body: resolutionBody,
        response: { 200: data },
      },
    },
    async (request) => {
      const { action, version, note, receiptId, refund } = request.body;
      let input: ResolutionInput;
      if (action === 'APPLY_TO_LINKED_INVOICE') {
        if (receiptId || refund) throw invalid('Application accepts only action, version and note');
        input = { action, version, note };
      } else if (action === 'LINK_EXISTING_RECEIPT') {
        if (!receiptId || refund)
          throw invalid('Linking requires receiptId and does not accept refund');
        input = { action, version, note, receiptId };
      } else {
        if (!refund || receiptId)
          throw invalid('Refund recording requires refund and does not accept receiptId');
        input = { action, version, note, refund };
      }
      return json({
        data: await services.paymentReview.resolve(
          request.params.attemptId,
          input,
          request.headers['idempotency-key'],
          request.auth!.accountId,
        ),
      });
    },
  );
  // Explicit UUID endpoint; legacy and public provider-reference routes remain unchanged.
  app.post(
    '/payment-orders/:orderId/reconcile-by-id',
    {
      preHandler: services.guards.write,
      schema: { tags: ['core payments review'], params: orderParams, response: { 200: data } },
    },
    async (request) =>
      json({ data: await services.commercial.reconcileById(request.params.orderId) }),
  );
};
