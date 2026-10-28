import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { CoreServices } from '../index.js';
import { publicPath } from '../domain/announcements.js';
import type { announcements } from '../persistence/announcements.schema.js';

const nullable = <T extends ReturnType<typeof Type.String>>(type: T) =>
  Type.Union([type, Type.Null()]);
const fields = {
  name: Type.String({ minLength: 1, maxLength: 120, pattern: '\\S' }),
  category: Type.Union([
    Type.Literal('GENERAL'),
    Type.Literal('NEW_JOURNEY'),
    Type.Literal('SEASONAL'),
    Type.Literal('TRAVEL_ADVISORY'),
    Type.Literal('SERVICE_UPDATE'),
  ]),
  message: Type.String({ minLength: 1, maxLength: 140, pattern: '\\S' }),
  linkText: nullable(Type.String({ minLength: 1, maxLength: 40 })),
  linkUrl: nullable(Type.String({ minLength: 1, maxLength: 2048 })),
  status: Type.Union([Type.Literal('DRAFT'), Type.Literal('PUBLISHED'), Type.Literal('ARCHIVED')]),
  startsAt: Type.String({ format: 'date-time' }),
  endsAt: nullable(Type.String({ format: 'date-time' })),
  placement: Type.Union([Type.Literal('HOME'), Type.Literal('PUBLIC'), Type.Literal('SELECTED')]),
  paths: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 30 }),
  priority: Type.Union([Type.Literal('NORMAL'), Type.Literal('IMPORTANT')]),
  dismissible: Type.Boolean(),
};
const record = Type.Object({
  ...fields,
  id: Type.String({ format: 'uuid' }),
  version: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
const publicRecord = Type.Object({
  id: Type.String(),
  revision: Type.Integer(),
  category: fields.category,
  message: fields.message,
  linkText: fields.linkText,
  linkUrl: fields.linkUrl,
  priority: fields.priority,
  dismissible: fields.dismissible,
  startsAt: fields.startsAt,
  endsAt: fields.endsAt,
});
const pageQuery = Type.Object(
  { page: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })) },
  { additionalProperties: false },
);
const publicResponse = Type.Object({ data: Type.Array(publicRecord), serverTime: Type.String() });
const present = (item: typeof announcements.$inferSelect) => ({
  ...item,
  startsAt: item.startsAt.toISOString(),
  endsAt: item.endsAt?.toISOString() ?? null,
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
});
const publicPresent = (item: typeof announcements.$inferSelect) => ({
  id: item.id,
  revision: item.version,
  category: item.category,
  message: item.message,
  linkText: item.linkText,
  linkUrl: item.linkUrl,
  priority: item.priority,
  dismissible: item.dismissible,
  startsAt: item.startsAt.toISOString(),
  endsAt: item.endsAt?.toISOString() ?? null,
});

export const announcementRoutes: FastifyPluginAsyncTypebox<{ services: CoreServices }> = async (
  app,
  { services },
) => {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.get(
    '/public/announcements',
    {
      schema: {
        tags: ['core announcements'],
        querystring: pageQuery,
        response: { 200: publicResponse },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const items = await services.announcements.active(publicPath(request.query.page ?? '/'), now);
      // Short shared cache; clients still enforce expiry between refreshes.
      reply.header('Cache-Control', 'public, max-age=0, s-maxage=30');
      return { data: items.map(publicPresent), serverTime: now.toISOString() };
    },
  );
  app.get(
    '/announcements/active',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core announcements'],
        querystring: pageQuery,
        response: { 200: publicResponse },
      },
    },
    async (request) => {
      const now = new Date();
      return {
        data: (await services.announcements.active(publicPath(request.query.page ?? '/'), now)).map(
          publicPresent,
        ),
        serverTime: now.toISOString(),
      };
    },
  );
  app.get(
    '/announcements',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core announcements'],
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
      const result = await services.announcements.list(page, pageSize);
      return {
        data: result.items.map(present),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.post(
    '/announcements',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core announcements'],
        body: Type.Object(fields, { additionalProperties: false }),
        response: { 201: Type.Object({ data: record }) },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send({
          data: present(await services.announcements.create(request.body, request.auth!.accountId)),
        }),
  );
  app.put(
    '/announcements/:id',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core announcements'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object(
          { ...fields, version: Type.Integer({ minimum: 1 }) },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ data: record }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return {
        data: present(
          await services.announcements.update(
            request.params.id,
            body,
            version,
            request.auth!.accountId,
          ),
        ),
      };
    },
  );
};
