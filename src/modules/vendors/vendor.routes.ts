import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { AuthGuards } from '../auth/auth.guard.js';
import {
  createVendorBodySchema,
  idParamsSchema,
  listQuerySchema,
  statusBodySchema,
  updateVendorBodySchema,
  vendorSchema,
} from './vendor.schemas.js';
import type { VendorService } from './vendor.service.js';

export interface VendorRouteOptions {
  readonly guards: AuthGuards;
  readonly vendorService: VendorService;
}

export const vendorRoutes: FastifyPluginAsyncTypebox<VendorRouteOptions> = async (app, options) => {
  app.addHook('preHandler', options.guards.admin);

  app.post(
    '/',
    {
      schema: {
        tags: ['vendors'],
        summary: 'Create an outsourced-driver vendor',
        body: createVendorBodySchema,
        response: { 201: Type.Object({ data: vendorSchema }) },
      },
    },
    async (request, reply) => {
      const vendor = await options.vendorService.create(request.body, request.auth!.accountId);
      return reply.status(201).send({ data: serializeVendor(vendor) });
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['vendors'],
        summary: 'Edit a vendor',
        params: idParamsSchema,
        body: updateVendorBodySchema,
        response: { 200: Type.Object({ data: vendorSchema }) },
      },
    },
    async (request) => {
      const vendor = await options.vendorService.update(
        request.params.id,
        request.body,
        request.auth!.accountId,
      );
      return { data: serializeVendor(vendor) };
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['vendors'],
        summary: 'List vendors',
        querystring: listQuerySchema,
        response: {
          200: Type.Object({
            data: Type.Array(vendorSchema),
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
      const result = await options.vendorService.list({
        page,
        pageSize,
        ...(request.query.status ? { status: request.query.status } : {}),
      });
      return {
        data: result.items.map(serializeVendor),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );

  app.patch(
    '/:id/status',
    {
      schema: {
        tags: ['vendors'],
        summary: 'Activate, deactivate, or archive a vendor',
        params: idParamsSchema,
        body: statusBodySchema,
        response: { 200: Type.Object({ data: vendorSchema }) },
      },
    },
    async (request) => {
      const vendor = await options.vendorService.changeStatus(
        request.params.id,
        request.body.status,
        request.auth!.accountId,
      );
      return { data: serializeVendor(vendor) };
    },
  );
};

function serializeVendor(vendor: {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  status: 'ACTIVE' | 'DEACTIVATED' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}) {
  return {
    ...vendor,
    createdAt: vendor.createdAt.toISOString(),
    updatedAt: vendor.updatedAt.toISOString(),
    archivedAt: vendor.archivedAt?.toISOString() ?? null,
  };
}
