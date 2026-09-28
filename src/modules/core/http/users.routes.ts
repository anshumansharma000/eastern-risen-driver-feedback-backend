import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { CoreServices } from '../index.js';
import { nonblank, paramsSchema, querySchema, uuidSchema } from './masters.schemas.js';
const role = Type.Union([
  Type.Literal('CORE_ADMIN'),
  Type.Literal('CORE_REPORT_VIEWER'),
  Type.Literal('CORE_DATA_ENTRY'),
]);
const status = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('DEACTIVATED'),
  Type.Literal('ARCHIVED'),
]);
const password = Type.String({ minLength: 12, maxLength: 128 });
const safeUser = Type.Object({
  id: uuidSchema,
  username: Type.Union([Type.String(), Type.Null()]),
  email: Type.String(),
  displayName: Type.String(),
  role,
  status,
});
export const userRoutes: FastifyPluginAsyncTypebox<{ services: CoreServices }> = async (
  app,
  { services },
) => {
  app.addHook('preHandler', services.guards.admin);
  app.post(
    '/users',
    {
      schema: {
        tags: ['core users'],
        body: Type.Object(
          {
            username: Type.String({ pattern: '^[a-zA-Z0-9_.-]{3,64}$' }),
            email: Type.String({ format: 'email', maxLength: 320 }),
            displayName: nonblank,
            password,
            role,
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ data: safeUser }) },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send({ data: await services.identity.createUser(request.body, request.auth!.accountId) }),
  );
  app.put(
    '/users/:id',
    {
      schema: {
        tags: ['core users'],
        params: paramsSchema,
        body: Type.Object(
          {
            username: Type.String({ pattern: '^[a-zA-Z0-9_.-]{3,64}$' }),
            email: Type.String({ format: 'email', maxLength: 320 }),
            displayName: nonblank,
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ data: safeUser }) },
      },
    },
    async (request) => ({
      data: await services.identity.updateProfile(
        request.params.id,
        request.body,
        request.auth!.accountId,
      ),
    }),
  );
  app.get(
    '/users',
    {
      schema: {
        tags: ['core users'],
        querystring: Type.Omit(querySchema, ['status']),
        response: {
          200: Type.Object({
            data: Type.Array(safeUser),
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
      const result = await services.identity.listUsers(page, pageSize);
      return { data: result.items, pagination: { page, pageSize, total: result.total } };
    },
  );
  app.patch(
    '/users/:id/access',
    {
      schema: {
        tags: ['core users'],
        params: paramsSchema,
        body: Type.Object({ role, status }, { additionalProperties: false }),
        response: { 200: Type.Object({ data: safeUser }) },
      },
    },
    async (request) => ({
      data: await services.identity.updateUser(
        request.params.id,
        request.body,
        request.auth!.accountId,
      ),
    }),
  );
  app.post(
    '/users/:id/password-reset',
    {
      schema: {
        tags: ['core users'],
        params: paramsSchema,
        body: Type.Object({ password }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      await services.identity.resetPassword(
        request.params.id,
        request.body.password,
        request.auth!.accountId,
      );
      return reply.code(204).send();
    },
  );
};
