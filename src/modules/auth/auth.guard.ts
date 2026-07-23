import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
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

export function createAuthGuards(authService: AuthService, cookieName: string): AuthGuards {
  const resolve = async (request: FastifyRequest): Promise<void> => {
    request.auth = await authService.resolveSession(request.cookies[cookieName]);
  };

  const authenticated: preHandlerAsyncHookHandler = async (request) => {
    await resolve(request);
  };

  const admin: preHandlerAsyncHookHandler = async (request) => {
    await resolve(request);
    if (request.auth?.role !== 'ADMIN') {
      throw new AppError({
        code: 'ADMIN_ACCESS_REQUIRED',
        message: 'Administrator access is required',
        statusCode: 403,
      });
    }
  };

  const driver: preHandlerAsyncHookHandler = async (request) => {
    await resolve(request);
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
