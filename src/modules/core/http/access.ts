import type { preHandlerAsyncHookHandler } from 'fastify';
import { AppError } from '../../../shared/errors/app-error.js';
import type { CoreRole } from '../application/ports.js';
export function createCoreGuards(authenticated: preHandlerAsyncHookHandler) {
  const allow = (roles: readonly CoreRole[]): preHandlerAsyncHookHandler =>
    async function (request, reply) {
      await authenticated.call(this, request, reply);
      if (!request.auth || !roles.includes(request.auth.role as CoreRole))
        throw new AppError({
          code: 'CORE_ACCESS_REQUIRED',
          message: 'Your account does not have permission for this core operation',
          statusCode: 403,
        });
    };
  return {
    read: allow(['CORE_ADMIN', 'CORE_REPORT_VIEWER', 'CORE_DATA_ENTRY']),
    write: allow(['CORE_ADMIN', 'CORE_DATA_ENTRY']),
    admin: allow(['CORE_ADMIN']),
  };
}
