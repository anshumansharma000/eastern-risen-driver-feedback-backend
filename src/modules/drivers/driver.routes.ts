import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { paginationQuerySchema, paginationSchema } from '../../shared/http/response.schemas.js';
import type { AuthGuards } from '../auth/auth.guard.js';
import { idParamsSchema, listQuerySchema, statusBodySchema } from '../vendors/vendor.schemas.js';
import {
  adminResetDriverPasswordBodySchema,
  createDriverBodySchema,
  createDriverLeaveBodySchema,
  driverLeaveSchema,
  driverSchema,
  updateDriverBodySchema,
} from './driver.schemas.js';
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

  app.post(
    '/:id/leaves',
    {
      schema: {
        tags: ['drivers'],
        summary: 'Record a driver leave period',
        params: idParamsSchema,
        body: createDriverLeaveBodySchema,
        response: { 201: Type.Object({ data: driverLeaveSchema }) },
      },
    },
    async (request, reply) => {
      const leave = await options.driverService.createLeave(
        request.params.id,
        request.body,
        request.auth!.accountId,
      );
      return reply.status(201).send({ data: serializeLeave(leave) });
    },
  );

  app.get(
    '/:id/leaves',
    {
      schema: {
        tags: ['drivers'],
        summary: 'List a driver’s leave periods',
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: Type.Object({
            data: Type.Array(driverLeaveSchema),
            pagination: paginationSchema,
          }),
        },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 25;
      const result = await options.driverService.listLeaves(request.params.id, { page, pageSize });
      return {
        data: result.items.map(serializeLeave),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );

  app.delete(
    '/:id/leaves/:leaveId',
    {
      schema: {
        tags: ['drivers'],
        summary: 'Remove a driver leave period',
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          leaveId: Type.String({ format: 'uuid' }),
        }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      await options.driverService.deleteLeave(
        request.params.id,
        request.params.leaveId,
        request.auth!.accountId,
      );
      return reply.status(204).send(null);
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
            pagination: paginationSchema,
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

  app.get(
    '/:id',
    {
      schema: {
        tags: ['drivers'],
        summary: 'Get one driver account and operational profile',
        params: idParamsSchema,
        response: { 200: Type.Object({ data: driverSchema }) },
      },
    },
    async (request) => ({
      data: serializeDriver(await options.driverService.get(request.params.id)),
    }),
  );

  app.post(
    '/:id/password-reset',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['drivers'],
        summary: 'Directly set a new password for a driver',
        params: idParamsSchema,
        body: adminResetDriverPasswordBodySchema,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      await options.driverService.resetPassword(
        request.params.id,
        request.body.newPassword,
        request.auth!.accountId,
      );
      return reply.status(204).send(null);
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
  assignmentEnabled: boolean;
  shiftStartTime: string | null;
  shiftEndTime: string | null;
  timeZone: string;
  maxDailyDutyMinutes: number;
  status: 'ACTIVE' | 'DEACTIVATED' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}) {
  return {
    ...driver,
    shiftStartTime: driver.shiftStartTime?.slice(0, 5) ?? null,
    shiftEndTime: driver.shiftEndTime?.slice(0, 5) ?? null,
    createdAt: driver.createdAt.toISOString(),
    updatedAt: driver.updatedAt.toISOString(),
    archivedAt: driver.archivedAt?.toISOString() ?? null,
  };
}

function serializeLeave(leave: {
  id: string;
  driverId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  createdAt: Date;
}) {
  return {
    ...leave,
    startsAt: leave.startsAt.toISOString(),
    endsAt: leave.endsAt.toISOString(),
    createdAt: leave.createdAt.toISOString(),
  };
}
