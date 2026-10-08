import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { preHandlerAsyncHookHandler } from 'fastify';
import { Type } from 'typebox';
import { AppError } from '../../shared/errors/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import {
  createAuthGuards,
  sessionCookieOptions,
  sessionCookieClearOptions,
} from '../auth/auth.guard.js';
import { adminLoginBodySchema, loginResponseSchema } from '../auth/auth.schemas.js';
import { changePasswordBodySchema } from '../profiles/profile.schemas.js';
import type { CustomerService } from './customer.service.js';
import { publicBookingResponse } from '../core/http/commercial.routes.js';
import type { CoreServices } from '../core/index.js';

const uuid = Type.String({ format: 'uuid' });
const name = Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' });
const email = Type.String({ format: 'email', maxLength: 320 });
const token = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' });
const customerParams = Type.Object({ customerId: uuid });
const bookingParams = Type.Object({ customerId: uuid, bookingId: uuid });
const date = Type.String();
const money = Type.String({ pattern: '^\\d+\\.\\d{2}$' });
const nullableDate = Type.Union([date, Type.Null()]);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const data = <T extends Parameters<typeof Type.Object>[0][string]>(schema: T) =>
  Type.Object({ data: schema });
const pagination = Type.Object({
  page: Type.Integer(),
  pageSize: Type.Integer(),
  total: Type.Integer(),
});
const query = Type.Object(
  {
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
const profile = Type.Object({
  accountId: uuid,
  displayName: Type.String(),
  email,
  status: Type.String(),
});
const payment = Type.Object({ number: nullableString, date, amount: money, method: Type.String() });
const party = Type.Object({
  name: nullableString,
  address: nullableString,
  city: nullableString,
  state: nullableString,
  country: nullableString,
  postalCode: nullableString,
  gstNumber: nullableString,
});
const invoice = Type.Object({
  id: uuid,
  number: nullableString,
  financialYear: nullableString,
  date,
  status: Type.String(),
  total: money,
  received: money,
  adjusted: money,
  due: money,
  paymentStatus: Type.String(),
  subtotal: money,
  taxTotal: money,
  dueDate: nullableDate,
  company: party,
  customer: party,
  paymentInstructions: nullableString,
  footerNotes: nullableString,
  bankAccounts: Type.Array(
    Type.Object({
      name: Type.String(),
      bankName: nullableString,
      accountNumber: Type.String(),
      branch: nullableString,
      ifscCode: nullableString,
      swiftCode: nullableString,
    }),
  ),
  lines: Type.Array(
    Type.Object({
      position: Type.Integer(),
      description: Type.String(),
      amount: money,
      taxTreatment: Type.String(),
      taxAmount: money,
      total: money,
      taxes: Type.Array(
        Type.Object({ component: Type.String(), rate: Type.String(), amount: money }),
      ),
    }),
  ),
  guestDisplayText: Type.String(),
  label: nullableString,
  payments: Type.Array(payment),
});
type Json<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;
const json = <T>(value: T): Json<T> => JSON.parse(JSON.stringify(value)) as Json<T>;
const limited = { rateLimit: { max: 5, timeWindow: '1 minute' } };

export interface CustomerRouteOptions {
  service: CustomerService;
  authService: AuthService;
  cookieName: string;
  secureCookie: boolean;
}
export const customerRoutes: FastifyPluginAsyncTypebox<CustomerRouteOptions> = async (
  app,
  options,
) => {
  const { service, authService, cookieName, secureCookie } = options;
  const guards = createAuthGuards(authService, cookieName, secureCookie);
  const customer: preHandlerAsyncHookHandler = async function (request, reply) {
    await guards.authenticated.call(this, request, reply);
    if (request.auth?.role !== 'CUSTOMER')
      throw new AppError({
        code: 'CUSTOMER_ACCESS_REQUIRED',
        message: 'Customer access is required',
        statusCode: 403,
      });
  };
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  app.post(
    '/auth/login',
    {
      config: limited,
      schema: {
        tags: ['customer accounts'],
        body: adminLoginBodySchema,
        response: { 200: loginResponseSchema },
      },
    },
    async (request, reply) => {
      const session = await authService.loginCustomer(request.body.email, request.body.password);
      reply.setCookie(
        cookieName,
        session.token,
        sessionCookieOptions(secureCookie, session.expiresAt),
      );
      return { data: { user: session.principal, expiresAt: session.expiresAt.toISOString() } };
    },
  );
  app.post('/auth/logout', { schema: { tags: ['customer accounts'] } }, async (request, reply) => {
    await authService.logout(request.cookies[cookieName]);
    reply.clearCookie(cookieName, sessionCookieClearOptions(secureCookie));
    return reply.code(204).send();
  });
  app.post(
    '/invitations/context',
    {
      config: limited,
      schema: {
        tags: ['customer accounts'],
        body: Type.Object({ token }, { additionalProperties: false }),
        response: {
          200: data(
            Type.Object({
              email,
              displayName: Type.String(),
              customerName: Type.String(),
              category: Type.String(),
              expiresAt: date,
              existingUser: Type.Boolean(),
            }),
          ),
        },
      },
    },
    async (request) => json({ data: await service.invitationContext(request.body.token) }),
  );
  app.post(
    '/invitations/accept',
    {
      config: limited,
      schema: {
        tags: ['customer accounts'],
        body: Type.Object(
          { token, password: Type.String({ minLength: 1, maxLength: 128 }) },
          { additionalProperties: false },
        ),
        response: { 200: data(Type.Object({ customerId: uuid })) },
      },
    },
    async (request) => ({
      data: await service.activate(request.body.token, request.body.password),
    }),
  );
  app.post(
    '/auth/forgot-password',
    {
      config: limited,
      schema: {
        tags: ['customer accounts'],
        body: Type.Object({ email }, { additionalProperties: false }),
        response: { 202: data(Type.Object({ message: Type.String() })) },
      },
    },
    async (request, reply) => {
      await service.recover(request.body.email);
      return reply.code(202).send({
        data: {
          message: 'If an active customer account exists, recovery instructions will be sent.',
        },
      });
    },
  );
  app.post(
    '/auth/reset-password',
    {
      config: limited,
      schema: {
        tags: ['customer accounts'],
        body: Type.Object(
          { token, newPassword: Type.String({ minLength: 12, maxLength: 128 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      await service.resetPassword(request.body.token, request.body.newPassword);
      reply.clearCookie(cookieName, sessionCookieClearOptions(secureCookie));
      return reply.code(204).send();
    },
  );
  app.get(
    '/me',
    {
      preHandler: customer,
      schema: { tags: ['customer accounts'], response: { 200: data(profile) } },
    },
    async (request) => ({ data: await service.profile(request.auth!.accountId) }),
  );
  app.patch(
    '/me',
    {
      preHandler: customer,
      schema: {
        tags: ['customer accounts'],
        body: Type.Object({ displayName: name }, { additionalProperties: false }),
        response: { 200: data(profile) },
      },
    },
    async (request) => ({
      data: await service.updateProfile(request.auth!.accountId, request.body.displayName),
    }),
  );
  app.post(
    '/me/change-password',
    {
      preHandler: customer,
      config: limited,
      schema: { tags: ['customer accounts'], body: changePasswordBodySchema },
    },
    async (request, reply) => {
      await service.changePassword(
        request.auth!.accountId,
        request.body.currentPassword,
        request.body.newPassword,
      );
      reply.clearCookie(cookieName, sessionCookieClearOptions(secureCookie));
      return reply.code(204).send();
    },
  );
  app.get(
    '/accounts',
    {
      preHandler: customer,
      schema: {
        tags: ['customer accounts'],
        response: {
          200: data(
            Type.Array(
              Type.Object({ customerId: uuid, name: Type.String(), category: Type.String() }),
            ),
          ),
        },
      },
    },
    async (request) => ({ data: await service.accounts(request.auth!.accountId) }),
  );
  app.get(
    '/accounts/:customerId/bookings',
    {
      preHandler: customer,
      schema: {
        tags: ['customer accounts'],
        params: customerParams,
        querystring: query,
        response: {
          200: Type.Object({
            data: Type.Array(
              Type.Object({
                id: uuid,
                reference: Type.String(),
                title: Type.String(),
                status: Type.String(),
                serviceStartsOn: nullableDate,
                serviceEndsOn: nullableDate,
              }),
            ),
            pagination,
          }),
        },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1,
        pageSize = request.query.pageSize ?? 25;
      const result = await service.bookings(
        request.auth!.accountId,
        request.params.customerId,
        page,
        pageSize,
      );
      return { data: result.items, pagination: { page, pageSize, total: result.total } };
    },
  );
  app.get(
    '/accounts/:customerId/bookings/:bookingId',
    {
      preHandler: customer,
      schema: {
        tags: ['customer accounts'],
        params: bookingParams,
        response: { 200: publicBookingResponse },
      },
    },
    async (request) =>
      json({
        data: await service.bookingDetail(
          request.auth!.accountId,
          request.params.customerId,
          request.params.bookingId,
        ),
      }),
  );
  app.post(
    '/accounts/:customerId/bookings/:bookingId/accept',
    {
      preHandler: customer,
      config: limited,
      schema: {
        tags: ['customer accounts'],
        params: bookingParams,
        body: Type.Object(
          { quoteVersion: Type.Integer({ minimum: 1 }) },
          { additionalProperties: false },
        ),
        response: { 200: data(Type.Object({ version: Type.Integer(), acceptedAt: date })) },
      },
    },
    async (request) => {
      const accepted = await service.accept(
        request.auth!.accountId,
        request.params.customerId,
        request.params.bookingId,
        request.body.quoteVersion,
      );
      return {
        data: { version: accepted.version, acceptedAt: accepted.acceptedAt!.toISOString() },
      };
    },
  );
  app.post(
    '/accounts/:customerId/bookings/:bookingId/milestones/:milestoneId/checkout',
    {
      preHandler: customer,
      config: limited,
      schema: {
        tags: ['customer accounts'],
        params: Type.Object({ ...bookingParams.properties, milestoneId: uuid }),
        response: {
          200: data(
            Type.Object({
              provider: Type.String(),
              sessionId: Type.String(),
              orderId: Type.String(),
              amount: money,
            }),
          ),
        },
      },
    },
    async (request) => ({
      data: await service.checkout(
        request.auth!.accountId,
        request.params.customerId,
        request.params.bookingId,
        request.params.milestoneId,
      ),
    }),
  );
  app.post(
    '/accounts/:customerId/bookings/:bookingId/orders/:orderId/reconcile',
    {
      preHandler: customer,
      config: limited,
      schema: {
        tags: ['customer accounts'],
        params: Type.Object({
          ...bookingParams.properties,
          orderId: Type.String({ pattern: '^er_[a-f0-9]{32}$' }),
        }),
        response: {
          200: data(
            Type.Object({
              orderId: Type.String(),
              status: Type.String(),
              orderStatus: Type.String(),
              latestAttemptStatus: Type.String(),
              accountingStatus: Type.String(),
              hasUnresolvedAttempts: Type.Boolean(),
              canRetry: Type.Boolean(),
              lastCheckedAt: nullableString,
            }),
          ),
        },
      },
    },
    async (request) => ({
      data: await service.reconcile(
        request.auth!.accountId,
        request.params.customerId,
        request.params.bookingId,
        request.params.orderId,
      ),
    }),
  );
  app.get(
    '/accounts/:customerId/invoices',
    {
      preHandler: customer,
      schema: {
        tags: ['customer accounts'],
        params: customerParams,
        querystring: query,
        response: { 200: Type.Object({ data: Type.Array(invoice), pagination }) },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1,
        pageSize = request.query.pageSize ?? 25;
      const result = await service.billing(
        request.auth!.accountId,
        request.params.customerId,
        page,
        pageSize,
      );
      return json({ data: result.items, pagination: { page, pageSize, total: result.total } });
    },
  );
  app.get(
    '/accounts/:customerId/invoices/:invoiceId',
    {
      preHandler: customer,
      schema: {
        tags: ['customer accounts'],
        params: Type.Object({ customerId: uuid, invoiceId: uuid }),
        response: { 200: data(invoice) },
      },
    },
    async (request) =>
      json({
        data: await service.invoice(
          request.auth!.accountId,
          request.params.customerId,
          request.params.invoiceId,
        ),
      }),
  );
};

export const customerAccessRoutes: FastifyPluginAsyncTypebox<{
  service: CustomerService;
  core: CoreServices;
}> = async (app, { service, core }) => {
  app.addHook('preHandler', core.guards.admin);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  const invitation = Type.Object({
    id: uuid,
    email,
    displayName: Type.String(),
    expiresAt: date,
    consumedAt: nullableDate,
    revokedAt: nullableDate,
    createdAt: date,
  });
  app.get(
    '/customers/:customerId/access',
    {
      schema: {
        tags: ['customer access administration'],
        params: customerParams,
        response: {
          200: data(
            Type.Object({
              memberships: Type.Array(
                Type.Object({
                  id: uuid,
                  ...profile.properties,
                  createdAt: date,
                  revokedAt: nullableDate,
                }),
              ),
              invitations: Type.Array(invitation),
            }),
          ),
        },
      },
    },
    async (request) => json({ data: await service.accessList(request.params.customerId) }),
  );
  app.post(
    '/customers/:customerId/invitations',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['customer access administration'],
        params: customerParams,
        body: Type.Object({ email, displayName: name }, { additionalProperties: false }),
        response: {
          201: data(
            Type.Object({
              id: uuid,
              email,
              displayName: Type.String(),
              expiresAt: date,
              activationToken: token,
              activationUrl: nullableString,
              delivery: Type.Union([Type.Literal('QUEUED'), Type.Literal('MANUAL')]),
            }),
          ),
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        json({
          data: await service.invite(
            request.params.customerId,
            request.body,
            request.auth!.accountId,
          ),
        }),
      ),
  );
  app.delete(
    '/customers/:customerId/invitations/:invitationId',
    {
      schema: {
        tags: ['customer access administration'],
        params: Type.Object({ customerId: uuid, invitationId: uuid }),
      },
    },
    async (request, reply) => {
      await service.revokeInvitation(
        request.params.customerId,
        request.params.invitationId,
        request.auth!.accountId,
      );
      return reply.code(204).send();
    },
  );
  app.delete(
    '/customers/:customerId/memberships/:membershipId',
    {
      schema: {
        tags: ['customer access administration'],
        params: Type.Object({ customerId: uuid, membershipId: uuid }),
      },
    },
    async (request, reply) => {
      await service.revokeMembership(
        request.params.customerId,
        request.params.membershipId,
        request.auth!.accountId,
      );
      return reply.code(204).send();
    },
  );
};
