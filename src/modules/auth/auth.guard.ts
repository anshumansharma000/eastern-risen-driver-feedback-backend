import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { AppError } from '../../shared/errors/app-error.js';
import type { AuthService } from './auth.service.js';
import type { AuthPrincipal } from './auth.types.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthPrincipal | null;
  }
}

export interface AuthGuards {
  readonly authenticated: preHandlerAsyncHookHandler;
  readonly admin: preHandlerAsyncHookHandler;
  readonly driver: preHandlerAsyncHookHandler;
}

export function createAuthGuards(
  authService: AuthService,
  cookieName: string,
  secureCookie: boolean,
): AuthGuards {
  const resolve = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const resolution = await authService.resolveSession(request.cookies[cookieName]);
    request.auth = resolution.principal;
    if (resolution.renewal) {
      reply.setCookie(
        cookieName,
        resolution.renewal.token,
        sessionCookieOptions(secureCookie, resolution.renewal.expiresAt),
      );
    }
  };

  const authenticated: preHandlerAsyncHookHandler = async (request, reply) => {
    await resolve(request, reply);
  };

  const admin: preHandlerAsyncHookHandler = async (request, reply) => {
    await resolve(request, reply);
    if (request.auth?.role !== 'ADMIN') {
      throw new AppError({
        code: 'ADMIN_ACCESS_REQUIRED',
        message: 'Administrator access is required',
        statusCode: 403,
      });
    }
  };

  const driver: preHandlerAsyncHookHandler = async (request, reply) => {
    await resolve(request, reply);
    if (request.auth?.role !== 'DRIVER' || !request.auth.driverId) {
      throw new AppError({
        code: 'DRIVER_ACCESS_REQUIRED',
        message: 'Driver access is required',
        statusCode: 403,
      });
    }
  };

  return { authenticated, admin, driver };
}

export function sessionCookieOptions(secure: boolean, expiresAt: Date) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000)),
  };
}
