import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { healthResponseSchema } from './health.schemas.js';

export interface HealthRouteOptions {
  readonly databaseHealthCheck?: () => Promise<void>;
}

export const healthRoutes: FastifyPluginAsyncTypebox<HealthRouteOptions> = async (app, options) => {
  app.get(
    '/live',
    {
      schema: {
        tags: ['health'],
        summary: 'Process liveness check',
        response: { 200: healthResponseSchema },
      },
    },
    async () => ({
      status: 'ok',
      service: 'driver-feedback-api',
      timestamp: new Date().toISOString(),
    }) as const,
  );

  app.get(
    '/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Database readiness check',
        response: {
          200: healthResponseSchema,
          503: healthResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      try {
        await options.databaseHealthCheck?.();
        return {
          status: 'ok',
          service: 'driver-feedback-api',
          timestamp: new Date().toISOString(),
        } as const;
      } catch {
        return reply.status(503).send({
          status: 'unavailable',
          service: 'driver-feedback-api',
          timestamp: new Date().toISOString(),
        });
      }
    },
  );
};
