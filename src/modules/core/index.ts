import { ReportsRepository } from './persistence/reports.repository.js';
import { ReportingRepository } from './persistence/reporting.repository.js';
import { reportRoutes } from './http/reports.routes.js';
import { DrizzleQueryError } from 'drizzle-orm';
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { CoreIdentity, SharedCatalog } from './application/ports.js';
import type { CoreDatabase } from './persistence/database.js';
import { MastersRepository } from './persistence/masters.repository.js';
import { BillingRepository } from './persistence/billing.repository.js';
import { createCoreGuards } from './http/access.js';
import { masterRoutes } from './http/masters.routes.js';
import { billingRoutes } from './http/billing.routes.js';
import { userRoutes } from './http/users.routes.js';
import { catalogRoutes } from './http/catalog.routes.js';
import { AppError } from '../../shared/errors/app-error.js';
import { CommercialService } from './application/commercial.service.js';
import type { PaymentProvider } from './application/payment-provider.js';
import { commercialRoutes } from './http/commercial.routes.js';
import { isPostgresError } from '../../shared/database/postgres-error.js';
export function createCoreServices(
  db: CoreDatabase,
  identity: CoreIdentity,
  catalog: SharedCatalog,
  authenticated: preHandlerAsyncHookHandler,
  paymentProvider: PaymentProvider | null = null,
) {
  const billing = new BillingRepository(db, catalog);
  return {
    masters: new MastersRepository(db, catalog),
    reports: new ReportsRepository(db),
    reporting: new ReportingRepository(db),
    billing,
    commercial: new CommercialService(db, billing, paymentProvider),
    paymentProvider,
    identity,
    catalog,
    guards: createCoreGuards(authenticated),
  };
}
export type CoreServices = ReturnType<typeof createCoreServices>;
export const coreRoutes: FastifyPluginAsyncTypebox<{ services: CoreServices }> = async (
  app,
  options,
) => {
  // Translate persistence conflicts without returning SQL, identifiers or financial input.
  const parentHandler = app.errorHandler;
  app.setErrorHandler((error, request, reply) => {
    let translated = error;
    if (isPostgresError(error, '23505'))
      translated = new AppError({
        code: 'CORE_RECORD_CONFLICT',
        message: 'A record with this unique identifier already exists',
        statusCode: 409,
      });
    if (isPostgresError(error, '23503'))
      translated = new AppError({
        code: 'CORE_REFERENCE_INVALID',
        message: 'The referenced record does not exist or is still in use',
        statusCode: 422,
      });
    if (isPostgresError(error, '23514'))
      translated = new AppError({
        code: 'CORE_CONSTRAINT_FAILED',
        message: 'The operation violates a core data constraint',
        statusCode: 422,
      });
    if (translated === error && error instanceof DrizzleQueryError)
      translated = new AppError({
        code: 'CORE_DATABASE_ERROR',
        message:
          'The database operation failed; retry or contact the administrator with the request ID',
        statusCode: 503,
      });
    return parentHandler.call(app, translated, request, reply);
  });
  await app.register(reportRoutes, { services: options.services });
  await app.register(masterRoutes, { services: options.services });
  await app.register(billingRoutes, { services: options.services });
  await app.register(userRoutes, { services: options.services });
  await app.register(catalogRoutes, { services: options.services });
  await app.register(commercialRoutes, { services: options.services });
};
