import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { ApplicationServices } from './container.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { driverRoutes } from './modules/drivers/driver.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { vendorRoutes } from './modules/vendors/vendor.routes.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import originProtection from './plugins/origin-protection.js';

export interface BuildAppOptions {
  readonly databaseHealthCheck?: () => Promise<void>;
  readonly exposeDocs?: boolean;
  readonly logger?: FastifyServerOptions['logger'];
  readonly services?: ApplicationServices;
  readonly allowedOrigins?: readonly string[];
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: false }),
    requestIdHeader: 'x-request-id',
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(helmet);
  await app.register(sensible);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(originProtection, { allowedOrigins: options.allowedOrigins ?? [] });
  app.decorateRequest('auth', null);
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Eastern Risen Driver Feedback API',
        description: 'Backend contract for passenger, driver, and administrator experiences.',
        version: '0.1.0',
      },
      servers: [{ url: '/api/v1', description: 'Version 1 API' }],
      tags: [
        { name: 'health', description: 'Service health and readiness' },
        { name: 'authentication', description: 'Administrator and driver sessions' },
        { name: 'drivers', description: 'Administrator-managed driver accounts' },
        { name: 'vendors', description: 'Outsourced-driver vendors' },
      ],
    },
  });

  if (options.exposeDocs ?? true) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: false },
    });
  }

  await app.register(errorHandlerPlugin);
  await app.register(healthRoutes, {
    prefix: '/health',
    ...(options.databaseHealthCheck
      ? { databaseHealthCheck: options.databaseHealthCheck }
      : {}),
  });

  if (options.services) {
    await app.register(authRoutes, {
      prefix: '/api/v1/auth',
      authService: options.services.authService,
      guards: options.services.guards,
      cookieName: options.services.cookieName,
      secureCookie: options.services.secureCookie,
    });
    await app.register(vendorRoutes, {
      prefix: '/api/v1/admin/vendors',
      guards: options.services.guards,
      vendorService: options.services.vendorService,
    });
    await app.register(driverRoutes, {
      prefix: '/api/v1/admin/drivers',
      guards: options.services.guards,
      driverService: options.services.driverService,
    });
  }

  return app;
}
