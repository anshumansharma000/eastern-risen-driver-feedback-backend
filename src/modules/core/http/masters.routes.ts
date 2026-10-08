import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { CoreServices } from '../index.js';
import * as schemas from './masters.schemas.js';
import { present } from './present.js';
export const masterRoutes: FastifyPluginAsyncTypebox<{ services: CoreServices }> = async (
  app,
  { services },
) => {
  app.get(
    '/companies',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        querystring: schemas.querySchema,
        response: {
          200: Type.Object({
            data: Type.Array(schemas.companiesResponse),
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
      const result = await services.masters.listCompanies(
        page,
        pageSize,
        request.query.status,
        request.query.q,
      );
      return {
        data: result.items.map(present),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/companies/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        response: { 200: Type.Object({ data: schemas.companiesResponse }) },
      },
    },
    async (request) => ({ data: present(await services.masters.getCompanies(request.params.id)) }),
  );
  app.post(
    '/companies',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core masters'],
        body: schemas.companiesBody,
        response: { 201: Type.Object({ data: schemas.companiesResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        data: present(
          await services.masters.createCompanies(request.body, request.auth!.accountId),
        ),
      }),
  );
  app.put(
    '/companies/:id',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        body: schemas.companiesUpdate,
        response: { 200: Type.Object({ data: schemas.companiesResponse }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return {
        data: present(
          await services.masters.updateCompanies(
            request.params.id,
            body,
            version,
            request.auth!.accountId,
          ),
        ),
      };
    },
  );

  app.get(
    '/bank-accounts',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        querystring: Type.Object(
          { ...schemas.querySchema.properties, companyId: Type.Optional(schemas.uuidSchema) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            data: Type.Array(schemas.bankAccountsResponse),
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
      const result = await services.masters.listBankAccounts(
        page,
        pageSize,
        request.query.status,
        request.query.q,
        request.query.companyId,
      );
      return {
        data: result.items.map(present),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/bank-accounts/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        response: { 200: Type.Object({ data: schemas.bankAccountsResponse }) },
      },
    },
    async (request) => ({
      data: present(await services.masters.getBankAccounts(request.params.id)),
    }),
  );
  app.post(
    '/bank-accounts',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core masters'],
        body: schemas.bankAccountsBody,
        response: { 201: Type.Object({ data: schemas.bankAccountsResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        data: present(
          await services.masters.createBankAccounts(request.body, request.auth!.accountId),
        ),
      }),
  );
  app.put(
    '/bank-accounts/:id',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        body: schemas.bankAccountsUpdate,
        response: { 200: Type.Object({ data: schemas.bankAccountsResponse }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return {
        data: present(
          await services.masters.updateBankAccounts(
            request.params.id,
            body,
            version,
            request.auth!.accountId,
          ),
        ),
      };
    },
  );

  app.get(
    '/customers',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        querystring: schemas.customerQuerySchema,
        response: {
          200: Type.Object({
            data: Type.Array(schemas.customersResponse),
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
      const result = await services.masters.listCustomers(
        page,
        pageSize,
        request.query.status,
        request.query.category,
        request.query.q,
      );
      return {
        data: result.items.map(present),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/customers/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        response: { 200: Type.Object({ data: schemas.customersResponse }) },
      },
    },
    async (request) => ({ data: present(await services.masters.getCustomers(request.params.id)) }),
  );
  app.post(
    '/customers',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core masters'],
        body: schemas.customersBody,
        response: { 201: Type.Object({ data: schemas.customersResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        data: present(
          await services.masters.createCustomers(request.body, request.auth!.accountId),
        ),
      }),
  );
  app.put(
    '/customers/:id',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        body: schemas.customersUpdate,
        response: { 200: Type.Object({ data: schemas.customersResponse }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return {
        data: present(
          await services.masters.updateCustomers(
            request.params.id,
            body,
            version,
            request.auth!.accountId,
          ),
        ),
      };
    },
  );

  app.get(
    '/guests',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        querystring: schemas.querySchema,
        response: {
          200: Type.Object({
            data: Type.Array(schemas.guestsResponse),
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
      const result = await services.masters.listGuests(
        page,
        pageSize,
        request.query.status,
        request.query.q,
      );
      return {
        data: result.items.map(present),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/guests/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        response: { 200: Type.Object({ data: schemas.guestsResponse }) },
      },
    },
    async (request) => ({ data: present(await services.masters.getGuests(request.params.id)) }),
  );
  app.post(
    '/guests',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core masters'],
        body: schemas.guestsBody,
        response: { 201: Type.Object({ data: schemas.guestsResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        data: present(await services.masters.createGuests(request.body, request.auth!.accountId)),
      }),
  );
  app.put(
    '/guests/:id',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        body: schemas.guestsUpdate,
        response: { 200: Type.Object({ data: schemas.guestsResponse }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return {
        data: present(
          await services.masters.updateGuests(
            request.params.id,
            body,
            version,
            request.auth!.accountId,
          ),
        ),
      };
    },
  );

  app.get(
    '/hotels',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        querystring: schemas.querySchema,
        response: {
          200: Type.Object({
            data: Type.Array(schemas.hotelsResponse),
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
      const result = await services.masters.listHotels(
        page,
        pageSize,
        request.query.status,
        request.query.q,
      );
      return {
        data: result.items.map(present),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/hotels/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        response: { 200: Type.Object({ data: schemas.hotelsResponse }) },
      },
    },
    async (request) => ({ data: present(await services.masters.getHotels(request.params.id)) }),
  );
  app.post(
    '/hotels',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core masters'],
        body: schemas.hotelsBody,
        response: { 201: Type.Object({ data: schemas.hotelsResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        data: present(await services.masters.createHotels(request.body, request.auth!.accountId)),
      }),
  );
  app.put(
    '/hotels/:id',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        body: schemas.hotelsUpdate,
        response: { 200: Type.Object({ data: schemas.hotelsResponse }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return {
        data: present(
          await services.masters.updateHotels(
            request.params.id,
            body,
            version,
            request.auth!.accountId,
          ),
        ),
      };
    },
  );

  app.get(
    '/hotel-rates',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        querystring: Type.Object(
          { ...schemas.querySchema.properties, hotelId: Type.Optional(schemas.uuidSchema) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            data: Type.Array(schemas.hotelRatesResponse),
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
      const result = await services.masters.listHotelRates(
        page,
        pageSize,
        request.query.status,
        request.query.q,
        request.query.hotelId,
      );
      return {
        data: result.items.map(present),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/hotel-rates/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        response: { 200: Type.Object({ data: schemas.hotelRatesResponse }) },
      },
    },
    async (request) => ({ data: present(await services.masters.getHotelRates(request.params.id)) }),
  );
  app.post(
    '/hotel-rates',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core masters'],
        body: schemas.hotelRatesBody,
        response: { 201: Type.Object({ data: schemas.hotelRatesResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        data: present(
          await services.masters.createHotelRates(request.body, request.auth!.accountId),
        ),
      }),
  );
  app.put(
    '/hotel-rates/:id',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        body: schemas.hotelRatesUpdate,
        response: { 200: Type.Object({ data: schemas.hotelRatesResponse }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return {
        data: present(
          await services.masters.updateHotelRates(
            request.params.id,
            body,
            version,
            request.auth!.accountId,
          ),
        ),
      };
    },
  );

  app.get(
    '/service-categories',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        querystring: schemas.querySchema,
        response: {
          200: Type.Object({
            data: Type.Array(schemas.serviceCategoriesResponse),
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
      const result = await services.masters.listServiceCategories(
        page,
        pageSize,
        request.query.status,
        request.query.q,
      );
      return {
        data: result.items.map(present),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/service-categories/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        response: { 200: Type.Object({ data: schemas.serviceCategoriesResponse }) },
      },
    },
    async (request) => ({
      data: present(await services.masters.getServiceCategories(request.params.id)),
    }),
  );
  app.post(
    '/service-categories',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core masters'],
        body: schemas.serviceCategoriesBody,
        response: { 201: Type.Object({ data: schemas.serviceCategoriesResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        data: present(
          await services.masters.createServiceCategories(request.body, request.auth!.accountId),
        ),
      }),
  );
  app.put(
    '/service-categories/:id',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        body: schemas.serviceCategoriesUpdate,
        response: { 200: Type.Object({ data: schemas.serviceCategoriesResponse }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return {
        data: present(
          await services.masters.updateServiceCategories(
            request.params.id,
            body,
            version,
            request.auth!.accountId,
          ),
        ),
      };
    },
  );

  app.get(
    '/tax-rules',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        querystring: schemas.querySchema,
        response: {
          200: Type.Object({
            data: Type.Array(schemas.taxRulesResponse),
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
      const result = await services.masters.listTaxRules(
        page,
        pageSize,
        request.query.status,
        request.query.q,
      );
      return {
        data: result.items.map(present),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/tax-rules/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        response: { 200: Type.Object({ data: schemas.taxRulesResponse }) },
      },
    },
    async (request) => ({ data: present(await services.masters.getTaxRules(request.params.id)) }),
  );
  app.post(
    '/tax-rules',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core masters'],
        body: schemas.taxRulesBody,
        response: { 201: Type.Object({ data: schemas.taxRulesResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        data: present(await services.masters.createTaxRules(request.body, request.auth!.accountId)),
      }),
  );
  app.put(
    '/tax-rules/:id',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        body: schemas.taxRulesUpdate,
        response: { 200: Type.Object({ data: schemas.taxRulesResponse }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return {
        data: present(
          await services.masters.updateTaxRules(
            request.params.id,
            body,
            version,
            request.auth!.accountId,
          ),
        ),
      };
    },
  );

  app.get(
    '/vendor-profiles',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        querystring: Type.Object(
          { ...schemas.querySchema.properties, vendorId: Type.Optional(schemas.uuidSchema) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            data: Type.Array(schemas.vendorProfilesResponse),
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
      const result = await services.masters.listVendorProfiles(
        page,
        pageSize,
        request.query.status,
        request.query.q,
        request.query.vendorId,
      );
      return {
        data: result.items.map(present),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );
  app.get(
    '/vendor-profiles/:id',
    {
      preHandler: services.guards.read,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        response: { 200: Type.Object({ data: schemas.vendorProfilesResponse }) },
      },
    },
    async (request) => ({
      data: present(await services.masters.getVendorProfiles(request.params.id)),
    }),
  );
  app.post(
    '/vendor-profiles',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core masters'],
        body: schemas.vendorProfilesBody,
        response: { 201: Type.Object({ data: schemas.vendorProfilesResponse }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        data: present(
          await services.masters.createVendorProfiles(request.body, request.auth!.accountId),
        ),
      }),
  );
  app.put(
    '/vendor-profiles/:id',
    {
      preHandler: services.guards.write,
      schema: {
        tags: ['core masters'],
        params: schemas.paramsSchema,
        body: schemas.vendorProfilesUpdate,
        response: { 200: Type.Object({ data: schemas.vendorProfilesResponse }) },
      },
    },
    async (request) => {
      const { version, ...body } = request.body;
      return {
        data: present(
          await services.masters.updateVendorProfiles(
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
