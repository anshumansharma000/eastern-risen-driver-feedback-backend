import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { CoreServices } from '../index.js';
import { invalid } from '../domain/errors.js';
const requiredText = (maxLength: number) =>
  Type.String({ minLength: 1, maxLength, pattern: '\\S' });
const optionalText = (maxLength: number) => Type.Optional(Type.String({ maxLength }));
const body = Type.Object(
  {
    submissionId: Type.String({ format: 'uuid' }),
    type: Type.Union([Type.Literal('CONTACT'), Type.Literal('TOUR'), Type.Literal('TOUR_DETAIL')]),
    fullName: requiredText(200),
    email: Type.String({ format: 'email', maxLength: 320 }),
    phone: requiredText(64),
    website: Type.Optional(Type.String({ maxLength: 0 })),
    country: optionalText(100),
    contactMethod: Type.Optional(
      Type.Union([Type.Literal('Email'), Type.Literal('Phone call'), Type.Literal('WhatsApp')]),
    ),
    message: optionalText(10000),
    service: optionalText(200),
    tourTitle: optionalText(300),
    region: optionalText(200),
    duration: optionalText(100),
    travelDates: optionalText(300),
    adults: Type.Optional(Type.String({ pattern: '^(?:[1-9]|10|10\\+)$' })),
    children: Type.Optional(Type.String({ pattern: '^(?:[0-6]|6\\+)$' })),
    interests: optionalText(5000),
    requirements: optionalText(5000),
    additionalNotes: optionalText(10000),
    pageUrl: Type.String({ format: 'uri', maxLength: 2048 }),
  },
  { additionalProperties: false },
);
const receipt = Type.Object({ id: Type.String({ format: 'uuid' }), createdAt: Type.String() });
const record = Type.Object({
  ...receipt.properties,
  type: Type.String(),
  fullName: Type.String(),
  email: Type.String(),
  phone: Type.String(),
  details: Type.Record(Type.String(), Type.String()),
});
export const inquiryRoutes: FastifyPluginAsyncTypebox<{ services: CoreServices }> = async (
  app,
  { services },
) => {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  app.post(
    '/public/inquiries',
    {
      bodyLimit: 40000,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { tags: ['core inquiries'], body, response: { 201: Type.Object({ data: receipt }) } },
    },
    async (request, reply) => {
      const {
        submissionId,
        type,
        fullName,
        email,
        phone,
        website: _website,
        ...details
      } = request.body;
      if (type === 'CONTACT' && !details.message?.trim()) throw invalid('A message is required');
      if (
        type !== 'CONTACT' &&
        ['country', 'contactMethod', 'travelDates', 'adults'].some(
          (key) => !String(details[key as keyof typeof details] ?? '').trim(),
        )
      )
        throw invalid('Complete the required tour details');
      if (
        type === 'TOUR_DETAIL' &&
        ['tourTitle', 'region', 'duration'].some(
          (key) => !String(details[key as keyof typeof details] ?? '').trim(),
        )
      )
        throw invalid('Selected tour details are required');
      const url = new URL(details.pageUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw invalid('Invalid page URL');
      // Do not store query strings or fragments that might contain private tokens.
      details.pageUrl = url.origin + url.pathname;
      const data = await services.inquiries.create({
        id: submissionId,
        type,
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        details: Object.fromEntries(
          Object.entries(details).map(([key, value]) => [key, value.trim()]),
        ),
      });
      return reply
        .code(201)
        .send({ data: { id: data.id, createdAt: data.createdAt.toISOString() } });
    },
  );
  app.get(
    '/inquiries',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core inquiries'],
        querystring: Type.Object(
          {
            page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
            pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            data: Type.Array(record),
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
      const result = await services.inquiries.list(page, pageSize);
      return {
        data: result.items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/inquiries/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core inquiries'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: Type.Object({ data: record }) },
      },
    },
    async (request) => {
      const item = await services.inquiries.get(request.params.id);
      return { data: { ...item, createdAt: item.createdAt.toISOString() } };
    },
  );
};
