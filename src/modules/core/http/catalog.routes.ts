import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { CoreServices } from '../index.js';
import { nonblank, paramsSchema, querySchema, uuidSchema } from './masters.schemas.js';
const status = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('DEACTIVATED'),
  Type.Literal('ARCHIVED'),
]);
const nullableText = Type.Union([Type.String(), Type.Null()]);
const metadata = {
  id: uuidSchema,
  status,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  archivedAt: nullableText,
};
const vendorBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    contactName: Type.Optional(nonblank),
    contactEmail: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
    contactPhone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);
const vehicleBody = Type.Object(
  {
    registrationNumber: Type.String({ minLength: 1, maxLength: 64, pattern: '\\S' }),
    displayName: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    vehicleType: Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' }),
    registeredOwner: Type.Optional(Type.Union([nonblank, Type.Null()])),
    address: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }), Type.Null()]),
    ),
    contactNumber: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 64, pattern: '\\S' }), Type.Null()]),
    ),
    accountNumber: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128, pattern: '\\S' }), Type.Null()]),
    ),
    ifscCode: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 32, pattern: '\\S' }), Type.Null()]),
    ),
    bankName: Type.Optional(Type.Union([nonblank, Type.Null()])),
  },
  { additionalProperties: false },
);
const vendorResponse = Type.Object({
  ...metadata,
  name: Type.String(),
  contactName: nullableText,
  contactEmail: nullableText,
  contactPhone: nullableText,
});
const vehicleResponse = Type.Object({
  ...metadata,
  registrationNumber: Type.String(),
  displayName: Type.String(),
  vehicleType: Type.String(),
  registeredOwner: nullableText,
  address: nullableText,
  contactNumber: nullableText,
  accountNumber: nullableText,
  ifscCode: nullableText,
  bankName: nullableText,
});
export const catalogRoutes: FastifyPluginAsyncTypebox<{ services: CoreServices }> = async (
  app,
  { services },
) => {
  app.get(
    '/vendors',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core shared catalog'],
        querystring: Type.Omit(querySchema, ['status']),
        response: {
          200: Type.Object({
            data: Type.Array(vendorResponse),
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
      const result = await services.catalog.listVendors(page, pageSize);
      return { data: result.items, pagination: { page, pageSize, total: result.total } };
    },
  );
  app.get(
    '/vendors/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core shared catalog'],
        params: paramsSchema,
        response: { 200: Type.Object({ data: vendorResponse }) },
      },
    },
    async (request) => ({ data: await services.catalog.getVendor(request.params.id) }),
  );
  app.post(
    '/vendors',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core shared catalog'],
        body: vendorBody,
        response: { 201: Type.Object({ data: vendorResponse }) },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send({ data: await services.catalog.createVendor(request.body, request.auth!.accountId) }),
  );
  app.put(
    '/vendors/:id',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core shared catalog'],
        params: paramsSchema,
        body: vendorBody,
        response: { 200: Type.Object({ data: vendorResponse }) },
      },
    },
    async (request) => ({
      data: await services.catalog.updateVendor(
        request.params.id,
        request.body,
        request.auth!.accountId,
      ),
    }),
  );
  app.patch(
    '/vendors/:id/status',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core shared catalog'],
        params: paramsSchema,
        body: Type.Object({ status }, { additionalProperties: false }),
        response: { 200: Type.Object({ data: vendorResponse }) },
      },
    },
    async (request) => ({
      data: await services.catalog.setVendorStatus(
        request.params.id,
        request.body.status,
        request.auth!.accountId,
      ),
    }),
  );

  app.get(
    '/vehicles',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core shared catalog'],
        querystring: Type.Omit(querySchema, ['status']),
        response: {
          200: Type.Object({
            data: Type.Array(vehicleResponse),
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
      const result = await services.catalog.listVehicles(page, pageSize);
      return { data: result.items, pagination: { page, pageSize, total: result.total } };
    },
  );
  app.get(
    '/vehicles/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core shared catalog'],
        params: paramsSchema,
        response: { 200: Type.Object({ data: vehicleResponse }) },
      },
    },
    async (request) => ({ data: await services.catalog.getVehicle(request.params.id) }),
  );
  app.post(
    '/vehicles',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core shared catalog'],
        body: vehicleBody,
        response: { 201: Type.Object({ data: vehicleResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        data: await services.catalog.createVehicle(request.body, request.auth!.accountId),
      }),
  );
  app.put(
    '/vehicles/:id',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core shared catalog'],
        params: paramsSchema,
        body: vehicleBody,
        response: { 200: Type.Object({ data: vehicleResponse }) },
      },
    },
    async (request) => ({
      data: await services.catalog.updateVehicle(
        request.params.id,
        request.body,
        request.auth!.accountId,
      ),
    }),
  );
  app.patch(
    '/vehicles/:id/status',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core shared catalog'],
        params: paramsSchema,
        body: Type.Object({ status }, { additionalProperties: false }),
        response: { 200: Type.Object({ data: vehicleResponse }) },
      },
    },
    async (request) => ({
      data: await services.catalog.setVehicleStatus(
        request.params.id,
        request.body.status,
        request.auth!.accountId,
      ),
    }),
  );
};
