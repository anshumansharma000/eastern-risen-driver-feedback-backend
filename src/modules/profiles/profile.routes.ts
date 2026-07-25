import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { AuthGuards } from '../auth/auth.guard.js';
import {
  adminProfileSchema,
  changePasswordBodySchema,
  driverProfileSchema,
  updateAdminProfileBodySchema,
  updateDriverProfileBodySchema,
} from './profile.schemas.js';
import type { ProfileService } from './profile.service.js';

export interface ProfileRouteOptions {
  readonly guards: AuthGuards;
  readonly profileService: ProfileService;
  readonly cookieName: string;
}

export const adminProfileRoutes: FastifyPluginAsyncTypebox<ProfileRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.admin);

  app.get(
    '/',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Get the authenticated administrator profile',
        response: { 200: Type.Object({ data: adminProfileSchema }) },
      },
    },
    async (request) => ({
      data: serializeAdminProfile(await options.profileService.getAdmin(request.auth!.accountId)),
    }),
  );

  app.patch(
    '/',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Update the authenticated administrator profile',
        body: updateAdminProfileBodySchema,
        response: { 200: Type.Object({ data: adminProfileSchema }) },
      },
    },
    async (request) => ({
      data: serializeAdminProfile(
        await options.profileService.updateAdmin(request.auth!.accountId, request.body),
      ),
    }),
  );

  registerChangePassword(app, options);
};

export const driverProfileRoutes: FastifyPluginAsyncTypebox<ProfileRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.driver);

  app.get(
    '/',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Get the authenticated driver profile',
        response: { 200: Type.Object({ data: driverProfileSchema }) },
      },
    },
    async (request) => ({
      data: serializeDriverProfile(await options.profileService.getDriver(request.auth!.accountId)),
    }),
  );

  app.patch(
    '/',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Update safe self-service fields on the authenticated driver profile',
        body: updateDriverProfileBodySchema,
        response: { 200: Type.Object({ data: driverProfileSchema }) },
      },
    },
    async (request) => ({
      data: serializeDriverProfile(
        await options.profileService.updateDriver(request.auth!.accountId, request.body),
      ),
    }),
  );

  registerChangePassword(app, options);
};

function registerChangePassword(
  app: Parameters<FastifyPluginAsyncTypebox<ProfileRouteOptions>>[0],
  options: ProfileRouteOptions,
) {
  app.post(
    '/change-password',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Change the current account password and revoke all sessions',
        body: changePasswordBodySchema,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      await options.profileService.changePassword(
        request.auth!.accountId,
        request.body.currentPassword,
        request.body.newPassword,
      );
      reply.clearCookie(options.cookieName, { path: '/' });
      return reply.status(204).send(null);
    },
  );
}

function serializeAdminProfile(profile: Awaited<ReturnType<ProfileService['getAdmin']>>) {
  const { passwordChangedAt, lastLoginAt, createdAt, updatedAt, ...rest } = profile;
  return {
    ...rest,
    passwordChangedAt: passwordChangedAt.toISOString(),
    lastLoginAt: lastLoginAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

function serializeDriverProfile(profile: Awaited<ReturnType<ProfileService['getDriver']>>) {
  const {
    passwordChangedAt,
    lastLoginAt,
    createdAt,
    updatedAt,
    shiftStartTime,
    shiftEndTime,
    ...rest
  } = profile;
  return {
    ...rest,
    passwordChangedAt: passwordChangedAt.toISOString(),
    lastLoginAt: lastLoginAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    shiftStartTime: shiftStartTime?.slice(0, 5) ?? null,
    shiftEndTime: shiftEndTime?.slice(0, 5) ?? null,
  };
}
