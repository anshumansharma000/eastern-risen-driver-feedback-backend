import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { AuthGuards } from '../auth/auth.guard.js';
import { idParamsSchema, listQuerySchema, statusBodySchema } from '../vendors/vendor.schemas.js';
import { createDriverBodySchema, driverSchema, updateDriverBodySchema } from './driver.schemas.js';
import type { DriverService } from './driver.service.js';

export interface DriverRouteOptions {
  readonly guards: AuthGuards;
  readonly driverService: DriverService;
}

export const driverRoutes: FastifyPluginAsyncTypebox<DriverRouteOptions> = async (app, options) => {
  app.addHook('preHandler', options.guards.admin);

  app.post(
    '/',
    {
      schema: {
        tags: ['drivers'],
        summary: 'Create a driver account and profile',
        body: createDriverBodySchema,
        response: { 201: Type.Object({ data: driverSchema }) },
      },
    },
    async (request, reply) => {
      const driver = await options.driverService.create(request.body, request.auth!.accountId);
      return reply.status(201).send({ data: serializeDriver(driver) });
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['drivers'],
        summary: 'Edit a driver account and profile',
        params: idParamsSchema,
        body: updateDriverBodySchema,
        response: { 200: Type.Object({ data: driverSchema }) },
      },
    },
    async (request) => {
      const driver = await options.driverService.update(
        request.params.id,
        request.body,
        request.auth!.accountId,
      );
      return { data: serializeDriver(driver) };
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['drivers'],
        summary: 'List driver accounts',
        querystring: listQuerySchema,
        response: {
          200: Type.Object({
            data: Type.Array(driverSchema),
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
      const result = await options.driverService.list({
        page,
        pageSize,
        ...(request.query.status ? { status: request.query.status } : {}),
      });
      return {
        data: result.items.map(serializeDriver),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );

  app.patch(
    '/:id/status',
    {
      schema: {
        tags: ['drivers'],
        summary: 'Activate, deactivate, or archive a driver',
        params: idParamsSchema,
        body: statusBodySchema,
        response: { 200: Type.Object({ data: driverSchema }) },
      },
    },
    async (request) => {
      const driver = await options.driverService.changeStatus(
        request.params.id,
        request.body.status,
        request.auth!.accountId,
      );
      return { data: serializeDriver(driver) };
    },
  );
};

function serializeDriver(driver: {
  id: string;
  accountId: string;
  displayName: string;
  email: string;
  driverCode: string;
  phone: string | null;
  sourceType: 'AGENCY' | 'OUTSOURCED';
  vendorId: string | null;
  vendorName: string | null;
  status: 'ACTIVE' | 'DEACTIVATED' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}) {
  return {
    ...driver,
    createdAt: driver.createdAt.toISOString(),
    updatedAt: driver.updatedAt.toISOString(),
    archivedAt: driver.archivedAt?.toISOString() ?? null,
  };
}
