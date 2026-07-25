import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { AuthGuards } from '../auth/auth.guard.js';
import {
  adminAnalyticsSchema,
  analyticsQuerySchema,
  driverPerformanceQuerySchema,
  driverPerformanceSchema,
} from './analytics.schemas.js';
import type { AnalyticsService } from './analytics.service.js';

export interface AnalyticsRouteOptions {
  readonly guards: AuthGuards;
  readonly analyticsService: AnalyticsService;
}

export const adminAnalyticsRoutes: FastifyPluginAsyncTypebox<AnalyticsRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.admin);

  app.get(
    '/',
    {
      schema: {
        tags: ['analytics'],
        summary: 'Get filtered admin score and response analytics',
        querystring: analyticsQuerySchema,
        response: { 200: Type.Object({ data: adminAnalyticsSchema }) },
      },
    },
    async (request) => ({
      data: await options.analyticsService.getAdminAnalytics({
        ...(request.query.month ? { month: request.query.month } : {}),
        ...(request.query.driverId ? { driverId: request.query.driverId } : {}),
        ...(request.query.driverSource ? { driverSource: request.query.driverSource } : {}),
        ...(request.query.vendorId ? { vendorId: request.query.vendorId } : {}),
        ...(request.query.category ? { category: request.query.category } : {}),
      }),
    }),
  );
};

export const driverPerformanceRoutes: FastifyPluginAsyncTypebox<AnalyticsRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.driver);

  app.get(
    '/',
    {
      schema: {
        tags: ['driver performance'],
        summary: 'Get the authenticated driver’s aggregate performance without individual feedback',
        querystring: driverPerformanceQuerySchema,
        response: { 200: Type.Object({ data: driverPerformanceSchema }) },
      },
    },
    async (request) => ({
      data: await options.analyticsService.getDriverPerformance(
        request.auth!.driverId!,
        request.query.month,
      ),
    }),
  );
};
