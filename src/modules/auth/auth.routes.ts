import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { AuthService } from './auth.service.js';
import {
  adminLoginBodySchema,
  currentUserResponseSchema,
  driverLoginBodySchema,
  loginResponseSchema,
} from './auth.schemas.js';
import { sessionCookieOptions, type AuthGuards } from './auth.guard.js';

export interface AuthRouteOptions {
  readonly authService: AuthService;
  readonly guards: AuthGuards;
  readonly cookieName: string;
  readonly secureCookie: boolean;
}

export const authRoutes: FastifyPluginAsyncTypebox<AuthRouteOptions> = async (app, options) => {
  app.post(
    '/admin/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['authentication'],
        summary: 'Sign in an administrator',
        body: adminLoginBodySchema,
        response: { 200: loginResponseSchema },
      },
    },
    async (request, reply) => {
      const session = await options.authService.loginAdmin(
        request.body.email,
        request.body.password,
      );
      reply.setCookie(
        options.cookieName,
        session.token,
        sessionCookieOptions(options.secureCookie, session.expiresAt),
      );
      return { data: { user: session.principal, expiresAt: session.expiresAt.toISOString() } };
    },
  );

  app.post(
    '/driver/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['authentication'],
        summary: 'Sign in a driver with their driver ID',
        body: driverLoginBodySchema,
        response: { 200: loginResponseSchema },
      },
    },
    async (request, reply) => {
      const session = await options.authService.loginDriver(
        request.body.driverCode,
        request.body.password,
      );
      reply.setCookie(
        options.cookieName,
        session.token,
        sessionCookieOptions(options.secureCookie, session.expiresAt),
      );
      return { data: { user: session.principal, expiresAt: session.expiresAt.toISOString() } };
    },
  );

  app.post(
    '/logout',
    {
      schema: { tags: ['authentication'], summary: 'End the current session' },
    },
    async (request, reply) => {
      await options.authService.logout(request.cookies[options.cookieName]);
      reply.clearCookie(options.cookieName, { path: '/' });
      return reply.status(204).send();
    },
  );

  app.get(
    '/me',
    {
      preHandler: options.guards.authenticated,
      schema: {
        tags: ['authentication'],
        summary: 'Get the current authenticated account',
        response: { 200: currentUserResponseSchema },
      },
    },
    async (request) => ({ data: { user: request.auth! } }),
  );
};
