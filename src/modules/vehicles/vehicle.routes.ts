import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { AuthGuards } from '../auth/auth.guard.js';
import {
  createVehicleBodySchema,
  idParamsSchema,
  listQuerySchema,
  updateVehicleBodySchema,
  vehicleSchema,
  vehicleStatusBodySchema,
} from './vehicle.schemas.js';
import type { VehicleService } from './vehicle.service.js';

export interface VehicleRouteOptions {
  readonly guards: AuthGuards;
  readonly vehicleService: VehicleService;
}

export const vehicleRoutes: FastifyPluginAsyncTypebox<VehicleRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.admin);

  app.post(
    '/',
    {
      schema: {
        tags: ['vehicles'],
        summary: 'Create a vehicle',
        body: createVehicleBodySchema,
        response: { 201: Type.Object({ data: vehicleSchema }) },
      },
    },
    async (request, reply) => {
      const vehicle = await options.vehicleService.create(request.body, request.auth!.accountId);
      return reply.status(201).send({ data: serializeVehicle(vehicle) });
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['vehicles'],
        summary: 'List vehicles',
        querystring: listQuerySchema,
        response: {
          200: Type.Object({
            data: Type.Array(vehicleSchema),
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
      const result = await options.vehicleService.list({
        page,
        pageSize,
        ...(request.query.status ? { status: request.query.status } : {}),
      });
      return {
        data: result.items.map(serializeVehicle),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['vehicles'],
        summary: 'Get a vehicle',
        params: idParamsSchema,
        response: { 200: Type.Object({ data: vehicleSchema }) },
      },
    },
    async (request) => ({
      data: serializeVehicle(await options.vehicleService.get(request.params.id)),
    }),
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['vehicles'],
        summary: 'Edit a vehicle',
        params: idParamsSchema,
        body: updateVehicleBodySchema,
        response: { 200: Type.Object({ data: vehicleSchema }) },
      },
    },
    async (request) => ({
      data: serializeVehicle(
        await options.vehicleService.update(
          request.params.id,
          request.body,
          request.auth!.accountId,
        ),
      ),
    }),
  );

  app.patch(
    '/:id/status',
    {
      schema: {
        tags: ['vehicles'],
        summary: 'Activate, deactivate, or archive a vehicle',
        params: idParamsSchema,
        body: vehicleStatusBodySchema,
        response: { 200: Type.Object({ data: vehicleSchema }) },
      },
    },
    async (request) => ({
      data: serializeVehicle(
        await options.vehicleService.changeStatus(
          request.params.id,
          request.body.status,
          request.auth!.accountId,
        ),
      ),
    }),
  );
};

function serializeVehicle(vehicle: {
  id: string;
  registrationNumber: string;
  displayName: string;
  status: 'ACTIVE' | 'DEACTIVATED' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}) {
  return {
    ...vehicle,
    createdAt: vehicle.createdAt.toISOString(),
    updatedAt: vehicle.updatedAt.toISOString(),
    archivedAt: vehicle.archivedAt?.toISOString() ?? null,
  };
}
