import {
  adminTimelineRoutes,
  driverTimelineRoutes,
  linkTimelineRoutes,
} from './modules/timeline/timeline.routes.js';
import { customerRoutes, customerAccessRoutes } from './modules/customer/customer.routes.js';
import { coreRoutes } from './modules/core/index.js';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { ApplicationServices } from './container.js';
import {
  adminAnalyticsRoutes,
  driverPerformanceRoutes,
} from './modules/analytics/analytics.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { bookingRoutes } from './modules/bookings/booking.routes.js';
import { driverRoutes } from './modules/drivers/driver.routes.js';
import {
  adminEngagementRoutes,
  driverEngagementRoutes,
} from './modules/engagements/engagement.routes.js';
import { adminFeedbackRoutes } from './modules/feedback/admin-feedback.routes.js';
import { feedbackRoutes } from './modules/feedback/feedback.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import {
  adminProfileRoutes,
  coreProfileRoutes,
  driverProfileRoutes,
} from './modules/profiles/profile.routes.js';
import {
  consentRoutes,
  questionnaireRoutes,
} from './modules/questionnaires/questionnaire.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
import { adminTripRoutes, driverTripRoutes } from './modules/trips/trip.routes.js';
import { vehicleRoutes } from './modules/vehicles/vehicle.routes.js';
import { vendorRoutes } from './modules/vendors/vendor.routes.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import originProtection from './plugins/origin-protection.js';
import responseContractPlugin from './plugins/response-contract.js';

export interface BuildAppOptions {
  readonly databaseHealthCheck?: () => Promise<void>;
  readonly exposeDocs?: boolean;
  readonly logger?: FastifyServerOptions['logger'];
  readonly services?: ApplicationServices;
  readonly allowedOrigins?: readonly string[];
  readonly trustProxy?: FastifyServerOptions['trustProxy'];
  readonly connectionTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
  readonly bodyLimitBytes?: number;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: false }),
    requestIdHeader: 'x-request-id',
    trustProxy: options.trustProxy ?? false,
    connectionTimeout: options.connectionTimeoutMs ?? 10_000,
    requestTimeout: options.requestTimeoutMs ?? 30_000,
    keepAliveTimeout: options.keepAliveTimeoutMs ?? 72_000,
    bodyLimit: options.bodyLimitBytes ?? 1_048_576,
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(helmet);
  await app.register(sensible);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(originProtection, { allowedOrigins: options.allowedOrigins ?? [] });
  await app.register(responseContractPlugin);
  app.decorateRequest('auth', null);
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Eastern Risen API',
        description:
          'Modular backend for core operations and passenger, driver, and feedback administration.',
        version: '0.1.0',
      },
      servers: [{ url: '/api/v1', description: 'Version 1 API' }],
      tags: [
        {
          name: 'core masters',
          description: 'Core-owned company, customer, guest, hotel and tax configuration',
        },
        { name: 'core users', description: 'Scoped core account administration' },
        { name: 'core billing', description: 'Invoices, receipts and settlement adjustments' },
        { name: 'core reports', description: 'Receivables and guest activity' },
        { name: 'core shared catalog', description: 'Shared vendor and vehicle catalog adapters' },
        {
          name: 'feedback timeline',
          description: 'Feedback-product driver milestones, booking links and progress',
        },
        { name: 'health', description: 'Service health and readiness' },
        { name: 'authentication', description: 'Administrator and driver sessions' },
        { name: 'drivers', description: 'Administrator-managed driver accounts' },
        { name: 'vehicles', description: 'Administrator-managed vehicles' },
        { name: 'bookings', description: 'Passenger bookings spanning one or more trips' },
        { name: 'trips', description: 'Administrator trip management' },
        { name: 'driver trips', description: 'Trips assigned to the authenticated driver' },
        { name: 'engagements', description: 'Derived booking driver engagements' },
        {
          name: 'driver engagements',
          description: 'Feedback engagements assigned to the authenticated driver',
        },
        {
          name: 'questionnaires',
          description: 'Versioned questionnaire and consent configuration',
        },
        {
          name: 'passenger feedback',
          description: 'Passenger-safe feedback collection and synchronization',
        },
        { name: 'vendors', description: 'Outsourced-driver vendors' },
        { name: 'agency settings', description: 'Agency-wide behavior and display settings' },
        { name: 'feedback review', description: 'Administrator feedback inspection and review' },
        { name: 'analytics', description: 'Administrator score and response analytics' },
        { name: 'driver performance', description: 'Driver-safe aggregate performance' },
        { name: 'profiles', description: 'Administrator and driver self-service profiles' },
      ],
    },
  });

  if (options.exposeDocs ?? true) {
    const { default: swaggerUi } = await import('@fastify/swagger-ui');
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: false },
    });
  }

  await app.register(errorHandlerPlugin);
  await app.register(healthRoutes, {
    prefix: '/health',
    ...(options.databaseHealthCheck ? { databaseHealthCheck: options.databaseHealthCheck } : {}),
  });

  if (options.services) {
    await app.register(adminTimelineRoutes, {
      prefix: '/api/v1/admin/timeline',
      timelineService: options.services.timelineService,
      guards: options.services.guards,
    });
    await app.register(driverTimelineRoutes, {
      prefix: '/api/v1/driver/timeline',
      timelineService: options.services.timelineService,
      guards: options.services.guards,
    });
    await app.register(linkTimelineRoutes, {
      prefix: '/api/v1/driver-link/timeline',
      timelineService: options.services.timelineService,
    });
    await app.register(customerRoutes, {
      prefix: '/api/v1/customer',
      service: options.services.customerService,
      authService: options.services.authService,
      cookieName: options.services.customerCookieName,
      secureCookie: options.services.secureCookie,
    });
    await app.register(customerAccessRoutes, {
      prefix: '/api/v1/core',
      service: options.services.customerService,
      core: options.services.core,
    });
    await app.register(coreRoutes, { prefix: '/api/v1/core', services: options.services.core });
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
    await app.register(vehicleRoutes, {
      prefix: '/api/v1/admin/vehicles',
      guards: options.services.guards,
      vehicleService: options.services.vehicleService,
    });
    await app.register(bookingRoutes, {
      prefix: '/api/v1/admin/bookings',
      guards: options.services.guards,
      bookingService: options.services.bookingService,
      engagementService: options.services.engagementService,
    });
    await app.register(adminTripRoutes, {
      prefix: '/api/v1/admin/trips',
      guards: options.services.guards,
      tripService: options.services.tripService,
    });
    await app.register(adminEngagementRoutes, {
      prefix: '/api/v1/admin/engagements',
      guards: options.services.guards,
      bookingService: options.services.bookingService,
      engagementService: options.services.engagementService,
      feedbackService: options.services.feedbackService,
    });
    await app.register(driverTripRoutes, {
      prefix: '/api/v1/driver/trips',
      guards: options.services.guards,
      tripService: options.services.tripService,
    });
    await app.register(driverEngagementRoutes, {
      prefix: '/api/v1/driver/engagements',
      guards: options.services.guards,
      engagementService: options.services.engagementService,
      feedbackService: options.services.feedbackService,
    });
    await app.register(questionnaireRoutes, {
      prefix: '/api/v1/admin/questionnaires',
      guards: options.services.guards,
      questionnaireService: options.services.questionnaireService,
    });
    await app.register(consentRoutes, {
      prefix: '/api/v1/admin/consent-versions',
      guards: options.services.guards,
      questionnaireService: options.services.questionnaireService,
    });
    await app.register(feedbackRoutes, {
      prefix: '/api/v1/passenger/feedback',
      feedbackService: options.services.feedbackService,
    });
    await app.register(settingsRoutes, {
      prefix: '/api/v1/admin/settings',
      guards: options.services.guards,
      settingsService: options.services.settingsService,
    });
    await app.register(adminFeedbackRoutes, {
      prefix: '/api/v1/admin/feedback',
      guards: options.services.guards,
      adminFeedbackService: options.services.adminFeedbackService,
    });
    await app.register(adminAnalyticsRoutes, {
      prefix: '/api/v1/admin/analytics',
      guards: options.services.guards,
      analyticsService: options.services.analyticsService,
    });
    await app.register(driverPerformanceRoutes, {
      prefix: '/api/v1/driver/performance',
      guards: options.services.guards,
      analyticsService: options.services.analyticsService,
    });
    await app.register(adminProfileRoutes, {
      prefix: '/api/v1/admin/profile',
      guards: options.services.guards,
      profileService: options.services.profileService,
      cookieName: options.services.cookieName,
      secureCookie: options.services.secureCookie,
    });
    await app.register(coreProfileRoutes, {
      prefix: '/api/v1/core/profile',
      guards: options.services.guards,
      profileService: options.services.profileService,
      cookieName: options.services.cookieName,
      secureCookie: options.services.secureCookie,
    });
    await app.register(driverProfileRoutes, {
      prefix: '/api/v1/driver/profile',
      guards: options.services.guards,
      profileService: options.services.profileService,
      cookieName: options.services.cookieName,
      secureCookie: options.services.secureCookie,
    });
  }

  return app;
}
