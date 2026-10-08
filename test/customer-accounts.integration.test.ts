import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices, type ApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import {
  authAccounts,
  auditEvents,
  outboxMessages,
  customerInvitations,
  customerMemberships,
  customerRecoveryTokens,
} from '../src/database/schema/index.js';
import { passwordHasher } from '../src/modules/auth/password.js';
import { createFieldEncryptor } from '../src/shared/security/field-encryption.js';
import { CommercialService } from '../src/modules/core/application/commercial.service.js';
import {
  deliverCustomerMail,
  type CustomerMailPayload,
} from '../src/modules/customer/customer-mail.js';
import type { PaymentProvider } from '../src/modules/core/application/payment-provider.js';

interface CreatedRecord {
  id: string;
  version: number;
  activationToken: string;
  activationUrl: string;
  accessToken: string;
  booking: { id: string };
}
interface StructuredCustomerEnvelope {
  data: {
    quote: { pricing: { grandTotal: string }; acceptedAt: string | null };
    paymentReady: boolean;
  };
}
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('customer accounts, private links and recovery', () => {
  let database: DatabaseClient, app: FastifyInstance, services: ApplicationServices;
  let staffCookie: string,
    customerCookie: string,
    staffId: string,
    customerId: string,
    otherCustomerId: string,
    categoryId: string,
    companyId: string,
    userId: string;
  let bookingId: string, bookingToken: string, milestoneId: string, invoiceId: string;
  const suffix = randomUUID(),
    email = `customer-${suffix}@example.com`,
    staffEmail = `staff-${suffix}@example.com`;
  const password = 'customer-password-123',
    recoveredPassword = 'customer-recovered-456';
  const encryptor = createFieldEncryptor(Buffer.alloc(32));
  const verified = new Map<
    string,
    { paymentId: string; amount: string; currency: string; receivedAt: string }
  >();
  const amounts = new Map<string, string>();
  const provider: PaymentProvider = {
    name: 'cashfree',
    createOrder: async (input) => {
      amounts.set(input.orderId, input.amount);
      return { sessionId: `session-${input.orderId}` };
    },
    inspectOrder: async (id) => {
      const payment = verified.get(id);
      return {
        status: payment ? 'PAID' : 'ACTIVE',
        rawStatus: payment ? 'PAID' : 'ACTIVE',
        expiresAt: null,
        attempts: payment
          ? [
              {
                ...payment,
                status: 'SUCCESS',
                rawStatus: 'SUCCESS',
                initiatedAt: payment.receivedAt,
                completedAt: payment.receivedAt,
                failureCode: null,
                failureMessage: null,
              },
            ]
          : [],
      };
    },
    verifyWebhook: () => true,
  };
  const call = (
    method: NonNullable<InjectOptions['method']>,
    url: string,
    payload?: unknown,
    cookie = staffCookie,
  ) =>
    app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      remoteAddress: randomUUID(),
      ...(payload === undefined
        ? {}
        : { payload: payload as NonNullable<InjectOptions['payload']> }),
    });
  async function create<T = CreatedRecord>(path: string, payload: unknown) {
    const response = await call('POST', `/api/v1/core${path}`, payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ data: T }>().data;
  }
  const invite = (id = customerId, targetEmail = email) =>
    create(`/customers/${id}/invitations`, { email: targetEmail, displayName: 'Customer contact' });
  const acceptInvite = (token: string, value = password) =>
    call('POST', '/api/v1/customer/invitations/accept', { token, password: value }, '');
  const accountPath = (path: string, id = customerId) => `/api/v1/customer/accounts/${id}${path}`;
  async function login(value = password) {
    const response = await call(
      'POST',
      '/api/v1/customer/auth/login',
      { email, password: value },
      '',
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.headers['set-cookie']!.toString().split(';')[0]!;
  }
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      DATABASE_SSL_MODE: 'disable',
      CUSTOMER_ACCOUNT_URL: 'https://eastern.example/account',
      CUSTOMER_MAIL_ENDPOINT: 'https://mail.example/relay',
      CUSTOMER_MAIL_TOKEN: 'test-relay-secret',
    });
    database = createDatabaseClient(config);
    const [staff] = await database.db
      .insert(authAccounts)
      .values({
        role: 'CORE_ADMIN',
        username: `customer-test-${suffix}`,
        email: staffEmail,
        displayName: 'Staff',
        passwordHash: await passwordHasher.hash(password),
      })
      .returning();
    staffId = staff!.id;
    services = createApplicationServices(database.db, config);
    services.core.commercial = new CommercialService(database.db, services.core.billing, provider);
    app = await buildApp({ exposeDocs: false, services });
    const response = await call(
      'POST',
      '/api/v1/auth/core/login',
      { username: staffEmail, password },
      '',
    );
    expect(response.statusCode, response.body).toBe(200);
    staffCookie = response.headers['set-cookie']!.toString().split(';')[0]!;
    companyId = (
      await create('/companies', {
        name: `Customer test company ${suffix}`,
        address: 'Test address',
        state: 'ODISHA',
        country: 'INDIA',
      })
    ).id;
    customerId = (
      await create('/customers', {
        name: `Customer ${suffix}`,
        category: 'CORPORATE',
        email,
        phone: '+919876543210',
      })
    ).id;
    otherCustomerId = (await create('/customers', { name: `Other ${suffix}`, category: 'LEISURE' }))
      .id;
    categoryId = (
      await create('/service-categories', {
        name: `Tour ${suffix}`,
        code: `C${suffix.slice(0, 8)}`,
      })
    ).id;
    const booking = await create('/commercial-bookings', {
      reference: `customer-${suffix}`,
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      title: 'Customer tour',
    });
    bookingId = booking.booking.id;
    bookingToken = booking.accessToken;
  });
  afterAll(async () => {
    await app?.close();
    if (database) {
      // Preserve financial fixtures for diagnosis in the disposable test database, remove credentials.
      const accounts = [staffId, userId].filter(Boolean);
      await database.db
        .delete(customerRecoveryTokens)
        .where(inArray(customerRecoveryTokens.accountId, accounts));
      await database.db
        .delete(customerMemberships)
        .where(inArray(customerMemberships.accountId, accounts));
      await database.db
        .delete(customerInvitations)
        .where(eq(customerInvitations.createdBy, staffId));
      await database.db.delete(auditEvents).where(inArray(auditEvents.actorAccountId, accounts));
      // Staff referenced by other fixtures is intentionally retained until the container is retired.
      await database.close();
    }
  });

  it('resends by replacing old invitations and activates exactly once without automatic email matching', async () => {
    const original = await invite();
    const replacement = await invite();
    expect(original.activationToken).not.toBe(replacement.activationToken);
    expect(replacement.activationUrl).toContain('/activate#token=');
    expect((await acceptInvite(original.activationToken)).statusCode).toBe(400);
    const context = await call(
      'POST',
      '/api/v1/customer/invitations/context',
      { token: replacement.activationToken },
      '',
    );
    expect(context.json<{ data: unknown }>().data).toMatchObject({
      email,
      category: 'CORPORATE',
      existingUser: false,
    });
    const results = await Promise.all([
      acceptInvite(replacement.activationToken),
      acceptInvite(replacement.activationToken),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    customerCookie = await login();
    expect(customerCookie.startsWith('id_customer=')).toBe(true);
    const me = await call('GET', '/api/v1/customer/me', undefined, customerCookie);
    userId = me.json<{ data: { accountId: string } }>().data.accountId;
    const accounts = await call('GET', '/api/v1/customer/accounts', undefined, customerCookie);
    expect(accounts.json<{ data: unknown[] }>().data).toEqual([
      { customerId, name: `Customer ${suffix}`, category: 'CORPORATE' },
    ]);
    expect(
      (await call('GET', '/api/v1/core/customers', undefined, customerCookie)).statusCode,
    ).toBe(401);
    expect(
      (
        await call(
          'GET',
          '/api/v1/customer/me',
          undefined,
          `id_customer=${staffCookie.split('=')[1]}`,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', '/api/v1/core/customers', undefined, `id=${customerCookie.split('=')[1]}`))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('GET', '/api/v1/core/customers', undefined, `${staffCookie}; ${customerCookie}`))
        .statusCode,
    ).toBe(200);
    expect(
      (await call('GET', accountPath('/bookings', otherCustomerId), undefined, customerCookie))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('GET', accountPath(`/bookings/${bookingId}`), undefined, customerCookie))
        .statusCode,
    ).toBe(404); // DRAFT hidden
  });

  it('requires an existing user password for another membership and supports invitation revocation and expiry', async () => {
    const invitation = await invite(otherCustomerId);
    expect((await acceptInvite(invitation.activationToken, 'wrong-password')).statusCode).toBe(401);
    expect((await acceptInvite(invitation.activationToken)).statusCode).toBe(200);
    expect(
      (await call('GET', '/api/v1/customer/accounts', undefined, customerCookie)).json<{
        data: unknown[];
      }>().data,
    ).toHaveLength(2);
    const another = await invite(customerId, `expired-${suffix}@example.com`);
    await database.db
      .update(customerInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(customerInvitations.id, another.id));
    expect((await acceptInvite(another.activationToken)).statusCode).toBe(400);
    const revoked = await invite(customerId, `revoked-${suffix}@example.com`);
    expect(
      (await call('DELETE', `/api/v1/core/customers/${customerId}/invitations/${revoked.id}`))
        .statusCode,
    ).toBe(204);
    expect((await acceptInvite(revoked.activationToken)).statusCode).toBe(400);
  });

  it('exposes identical structured terms through links and accounts with exact-version acceptance', async () => {
    const f = await create('/commercial-bookings', {
      reference: `structured-account-${randomUUID()}`,
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      title: 'Structured account tour',
    });
    const date = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const q = await create(`/commercial-bookings/${f.booking.id}/quotes`, {
      description: 'Transport',
      inclusions: 'Tour',
      exclusions: '',
      terms: 'Full payment',
      taxEffectiveDate: date,
      lines: [
        {
          description: 'Transport',
          amount: '100.00',
          taxTreatment: 'NON_TAXABLE',
          taxComponents: [],
        },
      ],
      paymentPlan: {
        mode: 'CUSTOM',
        milestones: [{ label: 'Full', amount: '100.00', dueOn: date }],
      },
    });
    const publicPath = `/api/v1/core/public/bookings/${f.accessToken}`;
    const privatePath = accountPath(`/bookings/${f.booking.id}`);
    const publicBefore = (
      await call('GET', publicPath, undefined, '')
    ).json<StructuredCustomerEnvelope>().data;
    expect(
      (await call('GET', privatePath, undefined, customerCookie)).json<StructuredCustomerEnvelope>()
        .data,
    ).toEqual(publicBefore);
    expect(publicBefore.quote.pricing.grandTotal).toBe('100.00');
    expect(publicBefore.paymentReady).toBe(false);
    const accept = await call(
      'POST',
      privatePath + '/accept',
      { quoteVersion: q.version },
      customerCookie,
    );
    expect(accept.statusCode, accept.body).toBe(200);
    expect(
      (await call('POST', publicPath + '/accept', { quoteVersion: q.version }, '')).statusCode,
    ).toBe(200);
    const publicAfter = (
      await call('GET', publicPath, undefined, '')
    ).json<StructuredCustomerEnvelope>().data;
    expect(
      (await call('GET', privatePath, undefined, customerCookie)).json<StructuredCustomerEnvelope>()
        .data,
    ).toEqual(publicAfter);
    expect(publicAfter.quote.acceptedAt).toBeTruthy();
    expect(
      (
        await call(
          'POST',
          `/api/v1/core/commercial-bookings/${f.booking.id}/billing-review`,
          {},
          customerCookie,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await call(
          'POST',
          `/api/v1/core/commercial-bookings/${f.booking.id}/enable-payment`,
          {
            quoteId: q.id,
            reviewToken: 'a'.repeat(64),
            invoiceDetails: {
              invoiceDate: date,
              guestDisplayText: 'Traveller',
              serviceProvidedAt: 'ODISHA',
              placeOfSupplyState: 'ODISHA',
              placeOfSupplyCountry: 'INDIA',
              bankAccountIds: [],
            },
          },
          '',
        )
      ).statusCode,
    ).toBe(401);
    const unrelatedPath = accountPath(`/bookings/${f.booking.id}`, otherCustomerId);
    expect((await call('GET', unrelatedPath, undefined, customerCookie)).statusCode).toBe(404);
  });

  it('uses the same quote and payment flow for links and accounts with safe responses', async () => {
    await create(`/commercial-bookings/${bookingId}/quotes`, {
      description: 'Tour',
      inclusions: '',
      exclusions: '',
      terms: 'Terms',
      total: '100.00',
    });
    expect(
      (
        await call(
          'POST',
          accountPath(`/bookings/${bookingId}/accept`),
          { quoteVersion: 99 },
          customerCookie,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          'POST',
          accountPath(`/bookings/${bookingId}/accept`),
          { quoteVersion: 1 },
          customerCookie,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await call('POST', `/api/v1/core/public/bookings/${bookingToken}/accept`, undefined, ''))
        .statusCode,
    ).toBe(200);
    const date = new Date().toISOString().slice(0, 10);
    invoiceId = (
      await create('/invoices', {
        companyId,
        customerId,
        serviceCategoryId: categoryId,
        invoiceDate: date,
        guestDisplayText: 'Traveller',
        serviceProvidedAt: 'ODISHA',
        placeOfSupplyState: 'ODISHA',
        placeOfSupplyCountry: 'INDIA',
        bankAccountIds: [],
        lines: [
          { description: 'Tour', amount: '100.00', taxTreatment: 'EXEMPT', taxComponents: [] },
        ],
      })
    ).id;
    const issued = await call('POST', `/api/v1/core/invoices/${invoiceId}/issue`, { version: 1 });
    expect(issued.statusCode, issued.body).toBe(200);
    expect(
      (await call('POST', `/api/v1/core/commercial-bookings/${bookingId}/invoice`, { invoiceId }))
        .statusCode,
    ).toBe(200);
    const schedule = await create<Array<{ id: string }>>(
      `/commercial-bookings/${bookingId}/schedule`,
      {
        milestones: [{ label: 'Full payment', amount: '100.00', dueOn: date }],
      },
    );
    milestoneId = schedule[0]!.id;
    const detail = await call(
      'GET',
      accountPath(`/bookings/${bookingId}`),
      undefined,
      customerCookie,
    );
    expect(detail.json<{ data: { invoice: { due: string } } }>().data.invoice.due).toBe('100.00');
    expect(detail.body).not.toContain('accessTokenHash');
    expect(detail.body).not.toContain('createdBy');
    const results = await Promise.all([
      call(
        'POST',
        accountPath(`/bookings/${bookingId}/milestones/${milestoneId}/checkout`),
        undefined,
        customerCookie,
      ),
      call(
        'POST',
        `/api/v1/core/public/bookings/${bookingToken}/milestones/${milestoneId}/checkout`,
        undefined,
        '',
      ),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const orderId = results[0].json<{ data: { orderId: string } }>().data.orderId;
    expect(results[1].json<{ data: { orderId: string } }>().data.orderId).toBe(orderId);
    verified.set(orderId, {
      paymentId: `payment-${suffix}`,
      amount: amounts.get(orderId)!,
      currency: 'INR',
      receivedAt: new Date().toISOString(),
    });
    expect(
      (
        await call(
          'POST',
          accountPath(`/bookings/${bookingId}/orders/${orderId}/reconcile`),
          undefined,
          customerCookie,
        )
      ).json<{ data: { status: string } }>().data.status,
    ).toBe('PAID');
    const publicDetail = await call(
      'GET',
      `/api/v1/core/public/bookings/${bookingToken}`,
      undefined,
      '',
    );
    const accountDetail = await call(
      'GET',
      accountPath(`/bookings/${bookingId}`),
      undefined,
      customerCookie,
    );
    expect(accountDetail.json<{ data: unknown }>().data).toEqual(
      publicDetail.json<{ data: unknown }>().data,
    );
    expect(accountDetail.json<{ data: { invoice: { due: string } } }>().data.invoice.due).toBe(
      '0.00',
    );
    const bill = await call('GET', accountPath('/invoices'), undefined, customerCookie);
    expect(bill.json<{ data: unknown[] }>().data[0]).toMatchObject({
      id: invoiceId,
      due: '0.00',
      received: '100.00',
    });
    expect(
      (
        await call(
          'GET',
          accountPath(`/invoices/${invoiceId}`, otherCustomerId),
          undefined,
          customerCookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          'POST',
          accountPath(
            `/bookings/${bookingId}/orders/er_${randomUUID().replaceAll('-', '')}/reconcile`,
          ),
          undefined,
          customerCookie,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('includes invoices without a commercial booking and excludes drafts from customer billing', async () => {
    const payload = {
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      invoiceDate: new Date().toISOString().slice(0, 10),
      guestDisplayText: 'Legacy traveller',
      serviceProvidedAt: 'ODISHA',
      placeOfSupplyState: 'ODISHA',
      placeOfSupplyCountry: 'INDIA',
      bankAccountIds: [],
      lines: [
        {
          description: 'Separate service',
          amount: '25.00',
          taxTreatment: 'NON_TAXABLE',
          taxComponents: [],
        },
      ],
    };
    const issuedInvoice = await create('/invoices', payload);
    const draftInvoice = await create('/invoices', payload);
    expect(
      (
        await call('POST', `/api/v1/core/invoices/${issuedInvoice.id}/issue`, {
          version: issuedInvoice.version,
        })
      ).statusCode,
    ).toBe(200);
    const billing = await call('GET', accountPath('/invoices'), undefined, customerCookie);
    expect(
      billing
        .json<{ data: Array<{ id: string }> }>()
        .data.some((item: { id: string }) => item.id === issuedInvoice.id),
    ).toBe(true);
    expect(
      billing
        .json<{ data: Array<{ id: string }> }>()
        .data.some((item: { id: string }) => item.id === draftInvoice.id),
    ).toBe(false);
    expect(
      (await call('GET', accountPath(`/invoices/${draftInvoice.id}`), undefined, customerCookie))
        .statusCode,
    ).toBe(404);
    const detail = await call(
      'GET',
      accountPath(`/invoices/${issuedInvoice.id}`),
      undefined,
      customerCookie,
    );
    expect(detail.json<{ data: unknown }>().data).toMatchObject({
      total: '25.00',
      due: '25.00',
      lines: [{ description: 'Separate service', amount: '25.00' }],
    });
    expect(detail.body).not.toContain('createdBy');
    expect(detail.body).not.toContain('snapshot');
    expect(detail.body).not.toContain('cancellationReason');
  });

  it('keeps membership and link revocation independent, restoring access through a fresh invitation', async () => {
    const rotated = await call('POST', `/api/v1/core/commercial-bookings/${bookingId}/rotate-link`);
    const newToken = rotated.json<{ data: { accessToken: string } }>().data.accessToken;
    expect(
      (await call('GET', `/api/v1/core/public/bookings/${bookingToken}`, undefined, '')).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', accountPath(`/bookings/${bookingId}`), undefined, customerCookie))
        .statusCode,
    ).toBe(200);
    const list = await call('GET', `/api/v1/core/customers/${customerId}/access`);
    expect(list.body).not.toContain('tokenHash');
    expect(list.body).not.toContain('passwordHash');
    const membership = list.json<{ data: { memberships: Array<{ id: string }> } }>().data
      .memberships[0]!;
    expect(
      (await call('DELETE', `/api/v1/core/customers/${customerId}/memberships/${membership.id}`))
        .statusCode,
    ).toBe(204);
    expect(
      (await call('GET', accountPath(`/bookings/${bookingId}`), undefined, customerCookie))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/api/v1/core/public/bookings/${newToken}`, undefined, '')).statusCode,
    ).toBe(200);
    const newInvite = await invite();
    expect((await acceptInvite(newInvite.activationToken)).statusCode).toBe(200);
  });

  it('delivers encrypted single-use recovery links, retries safely, and revokes prior sessions', async () => {
    const unknown = await call(
      'POST',
      '/api/v1/customer/auth/forgot-password',
      { email: `missing-${suffix}@example.com` },
      '',
    );
    const known = await call('POST', '/api/v1/customer/auth/forgot-password', { email }, '');
    expect(known.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
    const [job] = await database.db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.messageType, 'CUSTOMER_RECOVERY'),
          eq(
            outboxMessages.aggregateId,
            (
              await database.db
                .select()
                .from(customerRecoveryTokens)
                .where(eq(customerRecoveryTokens.accountId, userId))
            )[0]!.id,
          ),
        ),
      );
    expect(job!.payloadCiphertext).not.toContain(email);
    const failed = await deliverCustomerMail(database.db, encryptor, async () => {
      throw new Error('relay response must not be persisted');
    });
    expect(failed.failed).toBeGreaterThan(0);
    await database.db
      .update(outboxMessages)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(outboxMessages.id, job!.id));
    const messages: CustomerMailPayload[] = [];
    await deliverCustomerMail(database.db, encryptor, async (message, key) => {
      expect(key).toContain('customer-');
      messages.push(message);
    });
    const recovery = messages.find((m) => m.kind === 'RECOVERY' && m.email === email)!;
    const resetToken = recovery.url.split('#token=')[1]!;
    expect(
      (
        await call(
          'POST',
          '/api/v1/customer/auth/reset-password',
          { token: resetToken, newPassword: recoveredPassword },
          '',
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await call(
          'POST',
          '/api/v1/customer/auth/reset-password',
          { token: resetToken, newPassword: recoveredPassword },
          '',
        )
      ).statusCode,
    ).toBe(400);
    expect((await call('GET', '/api/v1/customer/me', undefined, customerCookie)).statusCode).toBe(
      401,
    );
    expect((await call('GET', '/api/v1/core/customers', undefined, staffCookie)).statusCode).toBe(
      200,
    );
    customerCookie = await login(recoveredPassword);
    expect(
      (
        await call(
          'PATCH',
          '/api/v1/customer/me',
          { displayName: 'New contact name' },
          customerCookie,
        )
      ).json<{ data: { displayName: string } }>().data.displayName,
    ).toBe('New contact name');
    expect(
      (await call('PATCH', '/api/v1/customer/me', { email: 'changed@example.com' }, customerCookie))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/api/v1/customer/me/change-password',
          { currentPassword: recoveredPassword, newPassword: password },
          customerCookie,
        )
      ).statusCode,
    ).toBe(204);
    expect((await call('GET', '/api/v1/customer/me', undefined, customerCookie)).statusCode).toBe(
      401,
    );
    const [sent] = await database.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, job!.id));
    expect(sent!.payloadCiphertext).toBeNull();
  });
});
