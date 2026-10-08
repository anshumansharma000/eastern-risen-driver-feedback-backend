import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices, type ApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import { authAccounts } from '../src/database/schema/accounts.js';
import { passwordHasher } from '../src/modules/auth/password.js';
import { CommercialService } from '../src/modules/core/application/commercial.service.js';
import type {
  PaymentProvider,
  ProviderPaymentAttempt,
  ProviderOrderSnapshot,
} from '../src/modules/core/application/payment-provider.js';
import {
  paymentAttempts,
  paymentAttemptResolutions,
  paymentOrders,
  paymentReconciliationJobs,
  paymentWebhookEvents,
} from '../src/modules/core/persistence/commercial.schema.js';

interface RecordEnvelope {
  data: { id: string; version: number };
  error: { code: string };
}
interface WorkflowEnvelope {
  error: { code: string };
  data: {
    booking: { id: string; invoiceId: string | null; createdBy: string; status: string };
    accessToken: string;
    quote: {
      proposedPlan: { milestones: { label: string; amount: string; dueOn: string }[] };
      pricing: { grandTotal: string };
      acceptedAt: string | null;
    };
    pricing: { grandTotal: string; taxTotal: string };
    grandTotal: string;
    taxTotal: string;
    paymentReady: boolean;
    invoice: { lines: { amount: string }[] };
    milestones: { dueOn: string }[];
    missingFields: string[];
    eligible: boolean;
    reviewToken: string;
    errors: { code: string }[];
  };
}
interface BookingDetail {
  data: {
    booking: { status: string; createdBy: string };
    milestones: { id: string; status: string; remainingAmount: string }[];
    orders: { status: string; receiptId: string | null }[];
    invoice: {
      receivedAmount: string;
      dueAmount: string;
      adjustmentAmount: string;
      receipts: { id: string; status: string }[];
    };
  };
}
import { processPaymentReconciliation } from '../src/modules/core/application/payment-reconciliation.js';
import { AppError } from '../src/shared/errors/app-error.js';
import { invoices, documentCounters } from '../src/modules/core/persistence/billing.schema.js';
import { receipts } from '../src/modules/core/persistence/billing.schema.js';
import { commercialBookings } from '../src/modules/core/persistence/commercial.schema.js';
import {
  gatewayReceiptKey,
  type ResolutionInput,
} from '../src/modules/core/application/payment-review.contracts.js';
import * as auditModule from '../src/modules/core/persistence/audit.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('commercial milestone payment lifecycle', () => {
  let database: DatabaseClient, app: FastifyInstance, services: ApplicationServices;
  let companyId: string, customerId: string, categoryId: string, bankId: string, cookie: string;
  const suffix = randomUUID().slice(0, 8);
  const date = new Date().toISOString().slice(0, 10);
  const verified = new Map<
    string,
    { paymentId: string; amount: string; currency: string; receivedAt: string }
  >();
  const snapshots = new Map<string, ProviderOrderSnapshot>();
  const amounts = new Map<string, string>();
  const provider: PaymentProvider = {
    name: 'cashfree',
    createOrder: async (input) => {
      amounts.set(input.orderId, input.amount);
      return { sessionId: `session-${input.orderId}` };
    },
    inspectOrder: async (id) => {
      if (snapshots.has(id)) return snapshots.get(id)!;
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
    path: string,
    payload?: unknown,
    key?: string,
  ) =>
    app.inject({
      method,
      url: `/api/v1/core${path}`,
      headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
      // Keep rate-limit behavior separate from this financial lifecycle suite.
      remoteAddress: randomUUID(),
      ...(payload === undefined
        ? {}
        : { payload: payload as NonNullable<InjectOptions['payload']> }),
    });
  async function create(path: string, body: unknown, key?: string) {
    const response = await call('POST', path, body, key);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<RecordEnvelope>().data;
  }
  async function fixture(invoiceDate = date) {
    const bookingResponse = await call('POST', '/commercial-bookings', {
      reference: `milestone-${randomUUID()}`,
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      title: 'Milestone regression',
    });
    expect(bookingResponse.statusCode, bookingResponse.body).toBe(201);
    const { booking, accessToken } = bookingResponse.json<{
      data: { booking: { id: string }; accessToken: string };
    }>().data;
    await create(`/commercial-bookings/${booking.id}/quotes`, {
      description: 'Tour',
      inclusions: '',
      exclusions: '',
      terms: 'Test terms',
      total: '100.01',
    });
    expect((await call('POST', `/public/bookings/${accessToken}/accept`)).statusCode).toBe(200);
    const invoice = await create('/invoices', {
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      invoiceDate,
      guestDisplayText: 'Traveller',
      serviceProvidedAt: 'ODISHA',
      placeOfSupplyState: 'ODISHA',
      placeOfSupplyCountry: 'INDIA',
      bankAccountIds: [bankId],
      lines: [
        { description: 'Tour', amount: '100.01', taxTreatment: 'NON_TAXABLE', taxComponents: [] },
      ],
    });
    expect(
      (await call('POST', `/invoices/${invoice.id}/issue`, { version: invoice.version }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call('POST', `/commercial-bookings/${booking.id}/invoice`, { invoiceId: invoice.id }))
        .statusCode,
    ).toBe(200);
    await create(`/commercial-bookings/${booking.id}/schedule`, {
      milestones: [
        { label: 'Initial', amount: '30.01', dueOn: date },
        { label: 'Balance', amount: '70.00', dueOn: date },
      ],
    });
    const detail = async () => {
      const response = await call('GET', `/commercial-bookings/${booking.id}`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<BookingDetail>().data;
    };
    const confirm = () =>
      call('POST', `/commercial-bookings/${booking.id}/status`, { status: 'CONFIRMED' });
    const receipt = (amount: string, status = 'CONFIRMED') =>
      create(
        '/receipts',
        {
          invoiceId: invoice.id,
          amount,
          receivedDate: date,
          method: 'CASH',
          details: {},
          status,
        },
        randomUUID(),
      );
    const checkout = async (position = 0) => {
      const milestones = (await detail()).milestones;
      const response = await call(
        'POST',
        `/public/bookings/${accessToken}/milestones/${milestones[position]!.id}/checkout`,
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ data: { orderId: string } }>().data.orderId;
    };
    return {
      id: booking.id,
      invoiceId: invoice.id,
      accessToken,
      detail,
      confirm,
      receipt,
      checkout,
    };
  }
  function verifyOrder(id: string, amount = amounts.get(id)!) {
    verified.set(id, {
      paymentId: `payment-${id}`,
      amount,
      currency: 'INR',
      receivedAt: `${date}T12:00:00+05:30`,
    });
  }
  function setAttempt(
    orderId: string,
    status: ProviderPaymentAttempt['status'],
    options: Partial<ProviderPaymentAttempt> = {},
    orderStatus: ProviderOrderSnapshot['status'] = 'ACTIVE',
  ) {
    const attempt: ProviderPaymentAttempt = {
      paymentId: `attempt-${orderId}`,
      status,
      rawStatus: status,
      amount: amounts.get(orderId)!,
      currency: 'INR',
      initiatedAt: `${date}T12:00:00+05:30`,
      completedAt: status === 'SUCCESS' || status === 'FAILED' ? `${date}T12:01:00+05:30` : null,
      failureCode: status === 'FAILED' ? 'BANK_DECLINED' : null,
      failureMessage: status === 'FAILED' ? 'Bank declined this attempt' : null,
      ...options,
    };
    snapshots.set(orderId, {
      status: orderStatus,
      rawStatus: orderStatus,
      expiresAt: null,
      attempts: [attempt],
    });
  }
  async function rows(orderId: string) {
    const [order] = await database.db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.providerOrderId, orderId));
    const attempts = await database.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, order!.id));
    const [job] = await database.db
      .select()
      .from(paymentReconciliationJobs)
      .where(eq(paymentReconciliationJobs.orderId, order!.id));
    return { order: order!, attempts, job: job! };
  }
  async function makeDue(
    orderId: string,
    values: Partial<typeof paymentReconciliationJobs.$inferInsert> = {},
  ) {
    const { order } = await rows(orderId);
    const [earliest] = await database.db
      .select({ at: sql<Date | null>`min(${paymentReconciliationJobs.nextCheckAt})` })
      .from(paymentReconciliationJobs);
    const dueAt = new Date(
      Math.min(Date.now(), earliest?.at ? new Date(earliest.at).getTime() : Date.now()) - 1000,
    );
    await database.db
      .update(paymentReconciliationJobs)
      .set({ nextCheckAt: dueAt, ...values })
      .where(eq(paymentReconciliationJobs.orderId, order.id));
    return order;
  }
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DATABASE_SSL_MODE: 'disable',
    });
    database = createDatabaseClient(config);
    const password = 'Milestone-regression-password-123';
    await database.db.insert(authAccounts).values({
      role: 'CORE_ADMIN',
      username: `milestone-${suffix}`,
      email: `milestone-${suffix}@example.com`,
      displayName: 'Milestone Test Admin',
      passwordHash: await passwordHasher.hash(password),
    });
    services = createApplicationServices(database.db, config);
    services.core.commercial = new CommercialService(database.db, services.core.billing, provider);
    services.core.paymentProvider = provider;
    app = await buildApp({ services, exposeDocs: false });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/core/login',
      payload: { username: `milestone-${suffix}`, password },
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
    companyId = (
      await create('/companies', {
        name: `Milestone Co ${suffix}`,
        address: 'Test address',
        state: 'ODISHA',
        country: 'INDIA',
        gstNumber: 'TEST-GST',
      })
    ).id;
    customerId = (
      await create('/customers', {
        name: 'Milestone Customer',
        category: 'LEISURE',
        state: 'ODISHA',
        country: 'INDIA',
        mobileNumber: '9876543210',
      })
    ).id;
    bankId = (
      await create('/bank-accounts', {
        companyId,
        name: 'Bank',
        accountNumber: '00001234',
        ifscCode: 'TEST0000123',
      })
    ).id;
    categoryId = (
      await create('/service-categories', { name: `Milestone Service ${suffix}`, code: '9985' })
    ).id;
  }, 30000);
  afterAll(async () => {
    if (database && amounts.size) {
      const owned = await database.db
        .select({ id: paymentOrders.id })
        .from(paymentOrders)
        .where(inArray(paymentOrders.providerOrderId, [...amounts.keys()]));
      await database.db
        .update(paymentReconciliationJobs)
        .set({ nextCheckAt: null, leaseToken: null, leaseUntil: null })
        .where(
          inArray(
            paymentReconciliationJobs.orderId,
            owned.map((order) => order.id),
          ),
        );
    }
    await app?.close();
    await database?.close();
  });

  async function structuredFixture(accept = true) {
    const response = await call('POST', '/commercial-bookings', {
      reference: `structured-${randomUUID()}`,
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      title: 'Structured Tour',
      serviceStartsOn: '2099-12-31',
    });
    const { booking, accessToken } = response.json<{
      data: { booking: { id: string }; accessToken: string };
    }>().data;
    const quoteInput = {
      description: 'Tour',
      inclusions: 'Transport',
      exclusions: '',
      terms: 'Agreed terms',
      taxEffectiveDate: date,
      lines: [
        { description: 'Tour', amount: '100.01', taxTreatment: 'NON_TAXABLE', taxComponents: [] },
      ],
      paymentPlan: {
        mode: 'CUSTOM',
        milestones: [
          { label: 'Initial', amount: '30.01', dueOn: date },
          { label: 'Balance', amount: '70.00', dueOn: '2099-12-01' },
        ],
      },
    };
    const quote = await create(`/commercial-bookings/${booking.id}/quotes`, quoteInput);
    if (accept)
      expect(
        (
          await call('POST', `/public/bookings/${accessToken}/accept`, {
            quoteVersion: quote.version,
          })
        ).statusCode,
      ).toBe(200);
    const invoiceDetails = {
      invoiceDate: date,
      guestDisplayText: 'Traveller',
      serviceProvidedAt: 'ODISHA',
      placeOfSupplyState: 'ODISHA',
      placeOfSupplyCountry: 'INDIA',
      bankAccountIds: [bankId],
    };
    const review = async () =>
      (
        await call('POST', `/commercial-bookings/${booking.id}/billing-review`, invoiceDetails)
      ).json<{
        data: {
          eligible: boolean;
          reviewToken: string;
          quoteId: string;
          errors: { code: string }[];
        };
      }>().data;
    return { id: booking.id, accessToken, quote, quoteInput, invoiceDetails, review };
  }
  it('calculates and atomically enables agreed billing exactly once under concurrent retries', async () => {
    const f = await structuredFixture();
    const calculation = await call('POST', `/commercial-bookings/${f.id}/quotes/calculate`, {
      lines: f.quoteInput.lines,
      taxEffectiveDate: date,
      paymentPlan: f.quoteInput.paymentPlan,
    });
    expect(calculation.json<WorkflowEnvelope>().data.pricing.grandTotal).toBe('100.01');
    const before = (await call('GET', `/public/bookings/${f.accessToken}`)).json<WorkflowEnvelope>()
      .data;
    expect(before.paymentReady).toBe(false);
    expect(before.quote.proposedPlan.milestones).toEqual(f.quoteInput.paymentPlan.milestones);
    const review = await f.review();
    expect(review.eligible).toBe(true);
    const input = {
      quoteId: f.quote.id,
      reviewToken: review.reviewToken,
      invoiceDetails: f.invoiceDetails,
    };
    const beforeInvoices = await database.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.companyId, companyId));
    const results = await Promise.all([
      call('POST', `/commercial-bookings/${f.id}/enable-payment`, input),
      call('POST', `/commercial-bookings/${f.id}/enable-payment`, input),
    ]);
    expect(
      results.map((r) => r.statusCode),
      results.map((r) => r.body).join(),
    ).toEqual([200, 200]);
    expect(results[0].json<WorkflowEnvelope>().data.booking.invoiceId).toBe(
      results[1].json<WorkflowEnvelope>().data.booking.invoiceId,
    );
    const afterInvoices = await database.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.companyId, companyId));
    expect(afterInvoices).toHaveLength(beforeInvoices.length + 1);
    expect(results[0].json<WorkflowEnvelope>().data.milestones).toHaveLength(2);
    expect(results[0].json<WorkflowEnvelope>().data.invoice.lines[0]?.amount).toBe('100.01');
    expect(results[0].json<WorkflowEnvelope>().data.booking.status).toBe('INVOICED');
    expect(
      (
        await call('POST', `/commercial-bookings/${f.id}/status`, { status: 'CONFIRMED' })
      ).json<WorkflowEnvelope>().error.code,
    ).toBe('INITIAL_PAYMENT_MISSING');
    expect(
      (await call('GET', `/public/bookings/${f.accessToken}`)).json<WorkflowEnvelope>().data
        .paymentReady,
    ).toBe(true);
    const changed = await call('POST', `/commercial-bookings/${f.id}/enable-payment`, {
      ...input,
      invoiceDetails: { ...f.invoiceDetails, guestDisplayText: 'Changed' },
    });
    expect(changed.json<WorkflowEnvelope>().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      (await call('POST', `/commercial-bookings/${f.id}/schedule`, {})).json<WorkflowEnvelope>()
        .error.code,
    ).toBe('SCHEDULE_ALREADY_SET');
  });
  it('rejects superseded acceptance and stale billing reviews without artifacts', async () => {
    const f = await structuredFixture();
    const review = await f.review();
    const next = await create(`/commercial-bookings/${f.id}/quotes`, f.quoteInput);
    expect(
      (
        await call('POST', `/public/bookings/${f.accessToken}/accept`, {
          quoteVersion: f.quote.version,
        })
      ).json<WorkflowEnvelope>().error.code,
    ).toBe('QUOTE_VERSION_CHANGED');
    expect(
      (
        await call('POST', `/public/bookings/${f.accessToken}/accept`, {
          quoteVersion: next.version,
        })
      ).statusCode,
    ).toBe(200);
    const stale = await call('POST', `/commercial-bookings/${f.id}/enable-payment`, {
      quoteId: f.quote.id,
      reviewToken: review.reviewToken,
      invoiceDetails: f.invoiceDetails,
    });
    expect(stale.json<WorkflowEnvelope>().error.code).toBe('STALE_BILLING_REVIEW');
    expect(
      (await call('GET', `/commercial-bookings/${f.id}`)).json<WorkflowEnvelope>().data.invoice,
    ).toBeNull();
  });
  it('requires versioned structured acceptance and refuses invoice-only changes after review', async () => {
    const f = await structuredFixture(false);
    expect(
      (await call('POST', `/public/bookings/${f.accessToken}/accept`)).json<WorkflowEnvelope>()
        .error.code,
    ).toBe('QUOTE_VERSION_REQUIRED');
    await call('POST', `/public/bookings/${f.accessToken}/accept`, {
      quoteVersion: f.quote.version,
    });
    const review = await f.review();
    const stale = await call('POST', `/commercial-bookings/${f.id}/enable-payment`, {
      quoteId: f.quote.id,
      reviewToken: review.reviewToken,
      invoiceDetails: { ...f.invoiceDetails, guestDisplayText: 'Changed' },
    });
    expect(stale.json<WorkflowEnvelope>().error.code).toBe('STALE_BILLING_REVIEW');
    const incomplete = (
      await call('POST', `/commercial-bookings/${f.id}/billing-review`, {})
    ).json<WorkflowEnvelope>().data;
    expect(incomplete.missingFields).toContain('invoiceDate');
    expect(incomplete.eligible).toBe(false);
  });
  it('rolls back issuance and invoice numbers after schedule failure and safely retries', async () => {
    const f = await structuredFixture();
    const review = await f.review();
    const input = {
      quoteId: f.quote.id,
      reviewToken: review.reviewToken,
      invoiceDetails: f.invoiceDetails,
    };
    const actor = (await call('GET', `/commercial-bookings/${f.id}`)).json<WorkflowEnvelope>().data
      .booking.createdBy;
    const beforeInvoices = await database.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.companyId, companyId));
    const beforeCounters = await database.db
      .select()
      .from(documentCounters)
      .where(eq(documentCounters.companyId, companyId));
    const original = services.core.billing.issueInTransaction.bind(services.core.billing);
    const spy = vi
      .spyOn(services.core.billing, 'issueInTransaction')
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('Simulated failure after issuance');
      });
    await expect(services.core.commercial.enablePayment(f.id, input, actor)).rejects.toThrow(
      'Simulated failure',
    );
    spy.mockRestore();
    expect(
      await database.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.companyId, companyId)),
    ).toHaveLength(beforeInvoices.length);
    expect(
      await database.db
        .select()
        .from(documentCounters)
        .where(eq(documentCounters.companyId, companyId)),
    ).toEqual(beforeCounters);
    expect(
      (await call('GET', `/commercial-bookings/${f.id}`)).json<WorkflowEnvelope>().data.invoice,
    ).toBeNull();
    expect(
      (await call('POST', `/commercial-bookings/${f.id}/enable-payment`, input)).statusCode,
    ).toBe(200);
  });
  it('keeps policy snapshots fixed and refuses missing default prerequisites', async () => {
    const f = await structuredFixture(false);
    const quote = await create(`/commercial-bookings/${f.id}/quotes`, {
      ...f.quoteInput,
      paymentPlan: { mode: 'COMPANY_DEFAULT' },
    });
    const before = (await call('GET', `/public/bookings/${f.accessToken}`)).json<WorkflowEnvelope>()
      .data.quote.proposedPlan;
    await call('PUT', `/companies/${companyId}/payment-policy`, {
      initialPercent: 45,
      balanceDaysBefore: 15,
      fullPaymentWithinDays: 10,
    });
    expect(
      (await call('GET', `/public/bookings/${f.accessToken}`)).json<WorkflowEnvelope>().data.quote
        .proposedPlan,
    ).toEqual(before);
    expect(quote.version).toBe(2);
    const legacy = await fixture();
    const review = (
      await call('POST', `/commercial-bookings/${legacy.id}/billing-review`, {})
    ).json<WorkflowEnvelope>().data;
    expect(review.errors.map((e: { code: string }) => e.code)).toContain(
      'LEGACY_QUOTE_REQUIRES_REVISION',
    );
  });

  it('checks full invoice scope and keeps partially processed bookings on the manual workflow', async () => {
    const f = await structuredFixture();
    const badInvoice = await create('/invoices', {
      ...f.invoiceDetails,
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      lines: [{ ...f.quoteInput.lines[0], description: 'Different scope' }],
    });
    await call('POST', `/invoices/${badInvoice.id}/issue`, { version: badInvoice.version });
    expect(
      (
        await call('POST', `/commercial-bookings/${f.id}/invoice`, { invoiceId: badInvoice.id })
      ).json<WorkflowEnvelope>().error.code,
    ).toBe('QUOTE_PRICING_REVIEW_REQUIRED');
    const invoice = await create('/invoices', {
      ...f.invoiceDetails,
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      lines: f.quoteInput.lines,
    });
    await call('POST', `/invoices/${invoice.id}/issue`, { version: invoice.version });
    const review = await f.review();
    const input = {
      quoteId: f.quote.id,
      reviewToken: review.reviewToken,
      invoiceDetails: f.invoiceDetails,
    };
    const results = await Promise.all([
      call('POST', `/commercial-bookings/${f.id}/invoice`, { invoiceId: invoice.id }),
      call('POST', `/commercial-bookings/${f.id}/enable-payment`, input),
    ]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const detail = (await call('GET', `/commercial-bookings/${f.id}`)).json<WorkflowEnvelope>()
      .data;
    if (detail.booking.invoiceId === invoice.id) {
      expect(results[1].json<WorkflowEnvelope>().error.code).toBe('LEGACY_BILLING_CONFLICT');
      expect(detail.milestones).toHaveLength(0);
      expect(
        (
          await call('POST', `/commercial-bookings/${f.id}/schedule`, {
            milestones: f.quoteInput.paymentPlan.milestones,
          })
        ).statusCode,
      ).toBe(201);
    } else {
      expect(results[0].json<WorkflowEnvelope>().error.code).toBe('BOOKING_ALREADY_INVOICED');
      expect(detail.milestones).toHaveLength(2);
    }
  });

  it('requires a dated default plan and rejects expired or cancelled quote acceptance', async () => {
    const response = await call('POST', '/commercial-bookings', {
      reference: `undated-${randomUUID()}`,
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      title: 'Undated',
    });
    const { booking, accessToken } = response.json<WorkflowEnvelope>().data;
    const f = await structuredFixture(false);
    const missing = await call('POST', `/commercial-bookings/${booking.id}/quotes`, {
      ...f.quoteInput,
      paymentPlan: { mode: 'COMPANY_DEFAULT' },
    });
    expect(missing.json<WorkflowEnvelope>().error.code).toBe('PAYMENT_PLAN_PREREQUISITES_MISSING');
    await create(`/commercial-bookings/${booking.id}/quotes`, {
      ...f.quoteInput,
      expiresOn: '2000-01-01',
    });
    expect(
      (
        await call('POST', `/public/bookings/${accessToken}/accept`, { quoteVersion: 1 })
      ).json<WorkflowEnvelope>().error.code,
    ).toBe('QUOTE_EXPIRED');
    await call('POST', `/commercial-bookings/${f.id}/status`, { status: 'CANCELLED' });
    expect(
      (
        await call('POST', `/public/bookings/${f.accessToken}/accept`, { quoteVersion: 1 })
      ).json<WorkflowEnvelope>().error.code,
    ).toBe('QUOTE_NOT_ACCEPTABLE');
  });
  it('preserves overdue accepted dates on delayed activation', async () => {
    const f = await structuredFixture();
    const later = new Date(Date.now() + 2 * 86400000);
    vi.spyOn(Date, 'now').mockReturnValue(later.getTime());
    try {
      const details = {
        ...f.invoiceDetails,
        invoiceDate: new Date(later.getTime() + 330 * 60000).toISOString().slice(0, 10),
      };
      const review = (
        await call('POST', `/commercial-bookings/${f.id}/billing-review`, details)
      ).json<WorkflowEnvelope>().data;
      expect(review.eligible).toBe(true);
      const enabled = await call('POST', `/commercial-bookings/${f.id}/enable-payment`, {
        quoteId: f.quote.id,
        reviewToken: review.reviewToken,
        invoiceDetails: details,
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      expect(enabled.json<WorkflowEnvelope>().data.milestones[0]?.dueOn).toBe(date);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('matches invoice tax calculations for each supported mode and detects changed tax settings', async () => {
    const f = await structuredFixture(false);
    const rules = [];
    for (const component of ['IGST', 'CGST', 'SGST'])
      rules.push(
        await create('/tax-rules', {
          name: `Structured ${component}`,
          component,
          rate: component === 'IGST' ? '5.00' : '2.50',
          serviceCategoryId: categoryId,
          effectiveFrom: date,
        }),
      );
    for (const [taxTreatment, taxComponents] of [
      ['TAXABLE', ['IGST']],
      ['TAXABLE', ['CGST', 'SGST']],
      ['NON_TAXABLE', []],
      ['EXEMPT', []],
      ['NIL_RATED', []],
    ] as const) {
      const lines = [
        {
          description: 'Rounding',
          amount: '0.10',
          taxTreatment,
          taxComponents: [...taxComponents],
        },
      ];
      const calc = await call('POST', `/commercial-bookings/${f.id}/quotes/calculate`, {
        lines,
        taxEffectiveDate: date,
        paymentPlan: { mode: 'COMPANY_DEFAULT' },
      });
      expect(calc.statusCode, calc.body).toBe(200);
      const invoice = await create('/invoices', {
        ...f.invoiceDetails,
        companyId,
        customerId,
        serviceCategoryId: categoryId,
        lines,
      });
      const invoiceDetail = (await call('GET', `/invoices/${invoice.id}`)).json<WorkflowEnvelope>()
        .data;
      expect(calc.json<WorkflowEnvelope>().data.pricing.grandTotal).toBe(invoiceDetail.grandTotal);
      expect(calc.json<WorkflowEnvelope>().data.pricing.taxTotal).toBe(invoiceDetail.taxTotal);
    }
    const quote = await create(`/commercial-bookings/${f.id}/quotes`, {
      ...f.quoteInput,
      lines: [
        {
          description: 'Taxed',
          amount: '100.01',
          taxTreatment: 'TAXABLE',
          taxComponents: ['IGST'],
        },
      ],
      paymentPlan: { mode: 'COMPANY_DEFAULT' },
    });
    await call('POST', `/public/bookings/${f.accessToken}/accept`, { quoteVersion: quote.version });
    const review = await f.review();
    expect(review.eligible).toBe(true);
    const updatedRate = await call('PUT', `/tax-rules/${rules[0]!.id}`, {
      name: 'Changed IGST',
      component: 'IGST',
      rate: '6.00',
      serviceCategoryId: categoryId,
      effectiveFrom: date,
      version: rules[0]!.version,
    });
    expect(updatedRate.statusCode, updatedRate.body).toBe(200);
    const changed = await f.review();
    expect(changed.errors.map((e) => e.code)).toContain('QUOTE_PRICING_REVIEW_REQUIRED');
    const enabled = await call('POST', `/commercial-bookings/${f.id}/enable-payment`, {
      quoteId: quote.id,
      reviewToken: review.reviewToken,
      invoiceDetails: f.invoiceDetails,
    });
    expect(enabled.json<WorkflowEnvelope>().error.code).toBe('QUOTE_PRICING_REVIEW_REQUIRED');
    expect(
      (await call('GET', `/commercial-bookings/${f.id}`)).json<WorkflowEnvelope>().data.invoice,
    ).toBeNull();
  });

  it('persists pending-to-failed and permits a retry without failing the order', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    setAttempt(orderId, 'PENDING');
    const pending = await services.core.commercial.reconcile(orderId);
    expect(pending).toMatchObject({
      status: 'PENDING',
      latestAttemptStatus: 'PENDING',
      canRetry: false,
    });
    const blocked = await call(
      'POST',
      `/public/bookings/${booking.accessToken}/milestones/${(await booking.detail()).milestones[0]!.id}/checkout`,
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<RecordEnvelope>().error.code).toBe('PAYMENT_ATTEMPT_PENDING');
    setAttempt(orderId, 'FAILED');
    await makeDue(orderId);
    expect(await processPaymentReconciliation(database.db, services.core.commercial)).toEqual({
      processed: 1,
      failed: 0,
    });
    const { order, attempts, job } = await rows(orderId);
    expect(order.status).toBe('READY');
    expect(attempts[0]).toMatchObject({
      status: 'FAILED',
      failureCode: 'BANK_DECLINED',
      accountingStatus: 'UNAPPLIED',
    });
    expect(job.nextCheckAt).not.toBeNull();
    expect((await services.core.commercial.reconcile(orderId)).canRetry).toBe(true);
    expect(await booking.checkout()).toBe(orderId);
    setAttempt(orderId, 'PENDING');
    await services.core.commercial.reconcile(orderId);
    expect((await rows(orderId)).attempts[0]).toMatchObject({
      status: 'FAILED',
      failureCode: 'BANK_DECLINED',
    });
    expect((await booking.detail()).invoice.receipts).toEqual([]);
  });

  it('recovers successful money without a webhook and never duplicates or downgrades its receipt', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    setAttempt(orderId, 'SUCCESS', {}, 'PAID');
    await makeDue(orderId);
    await processPaymentReconciliation(database.db, services.core.commercial);
    const first = await rows(orderId);
    expect(first.order.status).toBe('PAID');
    expect(first.attempts[0]).toMatchObject({
      status: 'SUCCESS',
      accountingStatus: 'APPLIED',
      receiptId: first.order.receiptId,
    });
    setAttempt(orderId, 'FAILED'); // A delayed contradictory gateway observation.
    await services.core.commercial.reconcile(orderId);
    expect((await rows(orderId)).attempts[0]?.status).toBe('SUCCESS');
    expect((await booking.detail()).invoice.receipts).toHaveLength(1);
  });

  it('credits a successful retry before the invoice date using the actual payment date', async () => {
    const invoiceDate = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
    const booking = await fixture(invoiceDate);
    const orderId = await booking.checkout();
    setAttempt(orderId, 'FAILED');
    await services.core.commercial.reconcile(orderId);
    setAttempt(orderId, 'SUCCESS', {}, 'PAID');
    const result = await services.core.commercial.reconcile(orderId);
    expect(result).toMatchObject({ status: 'PAID', accountingStatus: 'APPLIED' });
    expect((await rows(orderId)).order.reviewRequiredAt).toBeNull();
    const detail = await booking.detail();
    expect(detail.invoice.receivedAmount).toBe('30.01');
    expect(detail.invoice.dueAmount).toBe('70.00');
    expect(detail.invoice.receipts).toHaveLength(1);
    expect(detail.invoice.receipts[0]).toMatchObject({ receivedDate: date, status: 'CONFIRMED' });
    await services.core.commercial.reconcile(orderId);
    expect((await booking.detail()).invoice.receipts).toHaveLength(1);
  });

  it('does not mistake a provider outage for a failed payment and retries with backoff', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    setAttempt(orderId, 'PENDING');
    await services.core.commercial.reconcile(orderId);
    await makeDue(orderId);
    const failure = vi.spyOn(provider, 'inspectOrder').mockRejectedValueOnce(
      new AppError({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message: 'Unavailable',
        statusCode: 503,
      }),
    );
    try {
      expect(await processPaymentReconciliation(database.db, services.core.commercial)).toEqual({
        processed: 1,
        failed: 1,
      });
    } finally {
      failure.mockRestore();
    }
    const { attempts, job } = await rows(orderId);
    expect(attempts[0]?.status).toBe('PENDING');
    expect(job).toMatchObject({
      failureCount: 1,
      lastErrorCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
      leaseToken: null,
    });
    expect(job.nextCheckAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('keeps old pending attempts unresolved, including after order expiry', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    const { order } = await rows(orderId);
    await database.db
      .update(paymentOrders)
      .set({ createdAt: new Date(Date.now() - 30 * 86400000) })
      .where(eq(paymentOrders.id, order.id));
    setAttempt(orderId, 'PENDING', {}, 'EXPIRED');
    await makeDue(orderId);
    await processPaymentReconciliation(database.db, services.core.commercial);
    const saved = await rows(orderId);
    expect(saved.order.status).toBe('EXPIRED');
    expect(saved.order.reviewRequiredAt).not.toBeNull();
    expect(saved.attempts[0]?.status).toBe('PENDING');
    expect(saved.job.nextCheckAt).not.toBeNull();
    const retry = await call(
      'POST',
      `/public/bookings/${booking.accessToken}/milestones/${(await booking.detail()).milestones[0]!.id}/checkout`,
    );
    expect(retry.statusCode).toBe(409);
    setAttempt(orderId, 'FAILED', {}, 'EXPIRED');
    expect((await services.core.commercial.reconcile(orderId)).canRetry).toBe(true);
    expect((await rows(orderId)).order.reviewRequiredAt).toBeNull();
  });

  it('replaces an expired checkout and flags a late overpayment for accounting review', async () => {
    const booking = await fixture();
    const oldOrder = await booking.checkout();
    setAttempt(oldOrder, 'FAILED', {}, 'EXPIRED');
    const newOrder = await booking.checkout();
    expect(newOrder).not.toBe(oldOrder);
    setAttempt(newOrder, 'SUCCESS', {}, 'PAID');
    await services.core.commercial.reconcile(newOrder);
    // Pay the remaining balance manually, then the expired attempt succeeds late.
    await booking.receipt('70.00');
    setAttempt(oldOrder, 'SUCCESS', {}, 'PAID');
    expect(await services.core.commercial.reconcile(oldOrder)).toMatchObject({
      status: 'REVIEW_REQUIRED',
      accountingStatus: 'REVIEW_REQUIRED',
    });
    expect((await rows(oldOrder)).attempts[0]?.accountingStatus).toBe('REVIEW_REQUIRED');
    expect((await booking.detail()).invoice.receivedAmount).toBe('100.01');
    expect((await booking.detail()).invoice.receipts).toHaveLength(2);
  });

  it('deduplicates durable notifications and preserves a notification arriving during processing', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    await services.core.commercial.receivePaymentWebhook(orderId, `event-${orderId}`);
    await services.core.commercial.receivePaymentWebhook(orderId, `event-${orderId}`);
    const original = provider.inspectOrder.bind(provider);
    const spy = vi.spyOn(provider, 'inspectOrder').mockImplementationOnce(async (id) => {
      await services.core.commercial.receivePaymentWebhook(id, `new-event-${id}`);
      return original(id);
    });
    await makeDue(orderId);
    try {
      await processPaymentReconciliation(database.db, services.core.commercial);
    } finally {
      spy.mockRestore();
    }
    const { order, job } = await rows(orderId);
    const events = await database.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.orderId, order.id));
    expect(events).toHaveLength(2);
    expect(job.revision).toBe(2);
    expect(job.nextCheckAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(job.leaseToken).toBeNull();
  });

  it('reclaims expired worker leases and fences an older worker completion', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    setAttempt(orderId, 'PENDING');
    await makeDue(orderId, { leaseToken: randomUUID(), leaseUntil: new Date('2001-01-01') });
    await processPaymentReconciliation(database.db, services.core.commercial);
    expect((await rows(orderId)).job.leaseToken).toBeNull();
    const replacementToken = randomUUID();
    await makeDue(orderId);
    const original = provider.inspectOrder.bind(provider);
    const spy = vi.spyOn(provider, 'inspectOrder').mockImplementationOnce(async (id) => {
      const { order } = await rows(id);
      await database.db
        .update(paymentReconciliationJobs)
        .set({ leaseToken: replacementToken, leaseUntil: new Date(Date.now() + 120000) })
        .where(eq(paymentReconciliationJobs.orderId, order.id));
      return original(id);
    });
    try {
      await processPaymentReconciliation(database.db, services.core.commercial);
    } finally {
      spy.mockRestore();
    }
    expect((await rows(orderId)).job.leaseToken).toBe(replacementToken);
  });

  it('recovers a remotely created session after a process interruption', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    const { order } = await rows(orderId);
    await database.db
      .update(paymentOrders)
      .set({ status: 'CREATING', sessionId: null })
      .where(eq(paymentOrders.id, order.id));
    snapshots.set(orderId, {
      status: 'ACTIVE',
      rawStatus: 'ACTIVE',
      expiresAt: null,
      sessionId: 'recovered-session',
      attempts: [],
    });
    await makeDue(orderId);
    await processPaymentReconciliation(database.db, services.core.commercial);
    expect((await rows(orderId)).order).toMatchObject({
      status: 'READY',
      sessionId: 'recovered-session',
    });
  });

  it('records an additional success for review while preserving the original receipt', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    setAttempt(orderId, 'SUCCESS', {}, 'PAID');
    await services.core.commercial.reconcile(orderId);
    const first = (await rows(orderId)).attempts[0]!;
    snapshots
      .get(orderId)!
      .attempts.push({ ...snapshots.get(orderId)!.attempts[0]!, paymentId: `extra-${orderId}` });
    const result = await services.core.commercial.reconcile(orderId);
    expect(result).toMatchObject({
      status: 'REVIEW_REQUIRED',
      orderStatus: 'PAID',
      receiptId: first.receiptId,
    });
    const saved = await rows(orderId);
    expect(saved.attempts.map((attempt) => attempt.accountingStatus).sort()).toEqual([
      'APPLIED',
      'REVIEW_REQUIRED',
    ]);
    expect((await booking.detail()).invoice.receipts).toHaveLength(1);
    const blocked = await call(
      'POST',
      `/public/bookings/${booking.accessToken}/milestones/${(await booking.detail()).milestones[1]!.id}/checkout`,
    );
    expect(blocked.json<RecordEnvelope>().error.code).toBe('PAYMENT_REVIEW_REQUIRED');
  });

  it('does not let an older slow provider response overwrite a newer outcome', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    setAttempt(orderId, 'PENDING');
    const oldSnapshot = structuredClone(snapshots.get(orderId)!);
    let release!: (snapshot: ProviderOrderSnapshot) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const original = provider.inspectOrder.bind(provider);
    const spy = vi
      .spyOn(provider, 'inspectOrder')
      .mockImplementationOnce(async () => {
        signalStarted();
        return new Promise<ProviderOrderSnapshot>((resolve) => {
          release = resolve;
        });
      })
      .mockImplementation(original);
    try {
      const slow = services.core.commercial.reconcile(orderId);
      await started;
      setAttempt(orderId, 'FAILED');
      await services.core.commercial.reconcile(orderId);
      release(oldSnapshot);
      expect((await slow).status).toBe('FAILED');
      expect((await rows(orderId)).attempts[0]?.status).toBe('FAILED');
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts and queues a callback even while Cashfree is unreachable', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    const spy = vi.spyOn(provider, 'inspectOrder').mockRejectedValue(new Error('Gateway down'));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/core/payments/webhooks/cashfree',
        headers: { 'x-webhook-signature': 'test', 'x-webhook-timestamp': '1780000000' },
        payload: { data: { order: { order_id: orderId } } },
      });
      expect(response.statusCode).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      expect((await rows(orderId)).job.nextCheckAt).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('allows only one concurrent worker to inspect a leased order', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    await makeDue(orderId);
    const original = provider.inspectOrder.bind(provider);
    const calls: string[] = [];
    const spy = vi.spyOn(provider, 'inspectOrder').mockImplementation(async (id) => {
      calls.push(id);
      return original(id);
    });
    try {
      await Promise.all([
        processPaymentReconciliation(database.db, services.core.commercial),
        processPaymentReconciliation(database.db, services.core.commercial),
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(calls.filter((id) => id === orderId)).toHaveLength(1);
  });

  it('retries an interrupted local creation with the original provider order ID', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    const { order } = await rows(orderId);
    await database.db
      .update(paymentOrders)
      .set({ status: 'CREATING', sessionId: null })
      .where(eq(paymentOrders.id, order.id));
    const original = provider.inspectOrder.bind(provider);
    const inspector = vi
      .spyOn(provider, 'inspectOrder')
      .mockRejectedValueOnce(
        new AppError({
          code: 'PAYMENT_PROVIDER_ORDER_NOT_FOUND',
          message: 'Not found',
          statusCode: 502,
        }),
      )
      .mockImplementation(original);
    const creator = vi.spyOn(provider, 'createOrder');
    await makeDue(orderId);
    try {
      await processPaymentReconciliation(database.db, services.core.commercial);
      expect(creator).toHaveBeenCalledWith(expect.objectContaining({ orderId }));
      expect((await rows(orderId)).order.status).toBe('READY');
    } finally {
      inspector.mockRestore();
      creator.mockRestore();
    }
  });

  it('derives full payment from existing confirmed receipts without orders or stored allocation fields', async () => {
    const booking = await fixture();
    await booking.receipt('100.01');
    const detail = await booking.detail();
    expect(detail.orders).toEqual([]);
    expect(detail.milestones).toEqual([
      expect.objectContaining({ status: 'PAID', remainingAmount: '0.00' }),
      expect.objectContaining({ status: 'PAID', remainingAmount: '0.00' }),
    ]);
    const publicResponse = await call('GET', `/public/bookings/${booking.accessToken}`);
    expect(publicResponse.statusCode, publicResponse.body).toBe(200);
    expect(publicResponse.json<{ data: { milestones: unknown[] } }>().data.milestones).toEqual([
      expect.objectContaining({
        paid: true,
        remaining: '0.00',
        remainingAmount: '0.00',
        status: 'PAID',
      }),
      expect.objectContaining({
        paid: true,
        remaining: '0.00',
        remainingAmount: '0.00',
        status: 'PAID',
      }),
    ]);
    expect((await booking.confirm()).statusCode).toBe(200);
  });

  it('keeps partial and pending receipts distinct and confirms only after full initial coverage', async () => {
    const booking = await fixture();
    await booking.receipt('10.00');
    const pending = await booking.receipt('20.01', 'PENDING');
    expect((await booking.detail()).milestones[0]).toMatchObject({
      status: 'PARTIALLY_PAID',
      remainingAmount: '20.01',
    });
    const blocked = await booking.confirm();
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<RecordEnvelope>().error.code).toBe('INITIAL_PAYMENT_MISSING');
    expect((await call('POST', `/receipts/${pending.id}/confirm`)).statusCode).toBe(200);
    expect((await booking.detail()).milestones[0]).toMatchObject({
      status: 'PAID',
      remainingAmount: '0.00',
    });
    await booking.receipt('0.01');
    expect((await booking.detail()).milestones[1]).toMatchObject({
      status: 'PARTIALLY_PAID',
      remainingAmount: '69.99',
    });
    expect((await booking.confirm()).statusCode).toBe(200);
  });

  it('reallocates surviving receipts in position order after reversal and restores confirmation requirements', async () => {
    const booking = await fixture();
    const initial = await booking.receipt('30.01');
    await booking.receipt('10.00');
    expect((await booking.detail()).milestones[0]?.status).toBe('PAID');
    expect(
      (await call('POST', `/receipts/${initial.id}/reverse`, { reason: 'Returned payment' }))
        .statusCode,
    ).toBe(200);
    const detail = await booking.detail();
    expect(detail.milestones.map((item) => item.remainingAmount)).toEqual(['20.01', '70.00']);
    expect(detail.milestones.map((item) => item.status)).toEqual(['PARTIALLY_PAID', 'PENDING']);
    expect((await booking.confirm()).statusCode).toBe(409);
    await booking.receipt('20.01');
    expect((await booking.confirm()).statusCode).toBe(200);
    expect((await booking.detail()).booking.status).toBe('CONFIRMED');
  });

  it('does not count unverified, review-required, or stale paid orders as receipts', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    const pending = await call('POST', `/payment-orders/${orderId}/reconcile`);
    expect(pending.json<{ data: { status: string } }>().data.status).toBe('PENDING');
    verifyOrder(orderId, '30.00'); // Successful provider payment, mismatched amount: review only.
    const review = await call('POST', `/payment-orders/${orderId}/reconcile`);
    expect(review.json<{ data: { status: string } }>().data.status).toBe('REVIEW_REQUIRED');
    expect((await booking.detail()).invoice.receipts).toEqual([]);
    expect((await booking.detail()).milestones[0]).toMatchObject({
      status: 'PENDING',
      remainingAmount: '30.01',
    });
    // Existing inconsistent order data must not make a milestone paid.
    await database.db
      .update(paymentOrders)
      .set({ status: 'PAID' })
      .where(eq(paymentOrders.providerOrderId, orderId));
    expect((await booking.detail()).milestones[0]).toMatchObject({
      status: 'PENDING',
      remainingAmount: '30.01',
    });
    expect((await booking.confirm()).statusCode).toBe(409);
  });

  it('derives existing receipt coverage before an old unlinked order is reconciled, without repair', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    verifyOrder(orderId);
    const payment = verified.get(orderId)!;
    const receipt = await services.core.billing.createReceipt(
      {
        invoiceId: booking.invoiceId,
        amount: payment.amount,
        receivedDate: date,
        method: 'GATEWAY',
        details: { reference: `cashfree:${payment.paymentId}` },
        status: 'CONFIRMED',
      },
      `gw_${createHash('sha256').update(`cashfree:${payment.paymentId}`).digest('hex')}`,
      (await booking.detail()).booking.createdBy,
    );
    const beforeRetry = await booking.detail();
    expect(beforeRetry.orders[0]).toMatchObject({ status: 'READY', receiptId: null });
    expect(beforeRetry.milestones[0]).toMatchObject({ status: 'PAID', remainingAmount: '0.00' });
    expect((await call('POST', `/payment-orders/${orderId}/reconcile`)).statusCode).toBe(200);
    const afterRetry = await booking.detail();
    expect(afterRetry.invoice.receipts).toHaveLength(1);
    expect(afterRetry.orders[0]).toMatchObject({ status: 'PAID', receiptId: receipt.id });
    expect((await booking.confirm()).statusCode).toBe(200);
  });

  it('rechecks authoritative receipts if reversal completes while confirmation is starting', async () => {
    const booking = await fixture();
    const initial = await booking.receipt('30.01');
    let entered!: () => void;
    let resume!: () => void;
    const checkingBalance = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = services.core.billing.settlementBalance.bind(services.core.billing);
    const check = vi
      .spyOn(services.core.billing, 'settlementBalance')
      .mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return original(...args);
      });
    const confirming = booking.confirm();
    try {
      await checkingBalance;
      expect(
        (await call('POST', `/receipts/${initial.id}/reverse`, { reason: 'Returned payment' }))
          .statusCode,
      ).toBe(200);
      resume();
      const response = await confirming;
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<RecordEnvelope>().error.code).toBe('INITIAL_PAYMENT_MISSING');
      const detail = await booking.detail();
      expect(detail.booking.status).toBe('INVOICED');
      expect(detail.milestones[0]).toMatchObject({ status: 'PENDING', remainingAmount: '30.01' });
    } finally {
      resume();
      check.mockRestore();
      await confirming;
    }
  });

  it('serializes concurrent callbacks and reconciliation into one receipt and allocation', async () => {
    const booking = await fixture();
    // A gateway order for the second milestone still follows invoice-wide FIFO allocation.
    const orderId = await booking.checkout(1);
    verifyOrder(orderId);
    const responses = await Promise.all([
      call('POST', `/payment-orders/${orderId}/reconcile`),
      call('POST', `/payment-orders/${orderId}/reconcile`),
      call('POST', `/public/bookings/${booking.accessToken}/orders/${orderId}/reconcile`),
      app.inject({
        method: 'POST',
        url: '/api/v1/core/payments/webhooks/cashfree',
        headers: { 'x-webhook-signature': 'test', 'x-webhook-timestamp': '1780000000' },
        payload: { data: { order: { order_id: orderId } } },
      }),
    ]);
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    const detail = await booking.detail();
    expect(detail.invoice.receipts).toHaveLength(1);
    expect(detail.invoice.receivedAmount).toBe('70.00');
    expect(detail.milestones.map((item) => item.remainingAmount)).toEqual(['0.00', '30.01']);
    expect(detail.milestones.map((item) => item.status)).toEqual(['PAID', 'PARTIALLY_PAID']);
    expect(detail.orders[0]?.receiptId).toBe(detail.invoice.receipts[0]?.id);
    expect((await call('POST', `/payment-orders/${orderId}/reconcile`)).statusCode).toBe(200);
    expect((await booking.detail()).invoice.receipts).toHaveLength(1);
    expect(
      (
        await call('POST', `/receipts/${detail.invoice.receipts[0]!.id}/reverse`, {
          reason: 'Refund',
        })
      ).statusCode,
    ).toBe(409);
    // The existing PAID order is for milestone 2, whose balance is still 30.01.
    // Checkout must use receipt allocation rather than that order's status.
    const remainingOrder = await booking.checkout(1);
    expect(amounts.get(remainingOrder)).toBe('30.01');
    verifyOrder(remainingOrder);
    expect((await call('POST', `/payment-orders/${remainingOrder}/reconcile`)).statusCode).toBe(
      200,
    );
    const fullyPaid = await booking.detail();
    expect(fullyPaid.invoice.receipts).toHaveLength(2);
    expect(fullyPaid.milestones.map((item) => item.status)).toEqual(['PAID', 'PAID']);
    expect(fullyPaid.milestones.map((item) => item.remainingAmount)).toEqual(['0.00', '0.00']);
    expect((await booking.confirm()).statusCode).toBe(200);
  });

  it('rolls back a receipt if reconciliation fails before completing the order and safely retries', async () => {
    const booking = await fixture();
    const orderId = await booking.checkout();
    verifyOrder(orderId);
    const original = services.core.billing.createReceiptInTransaction.bind(services.core.billing);
    const fault = vi
      .spyOn(services.core.billing, 'createReceiptInTransaction')
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('Simulated interruption after receipt insertion');
      });
    try {
      expect((await call('POST', `/payment-orders/${orderId}/reconcile`)).statusCode).toBe(500);
    } finally {
      fault.mockRestore();
    }
    const failed = await booking.detail();
    expect(failed.invoice.receipts).toEqual([]);
    expect(failed.orders[0]?.status).toBe('READY');
    expect(failed.milestones[0]).toMatchObject({ status: 'PENDING', remainingAmount: '30.01' });
    expect((await call('POST', `/payment-orders/${orderId}/reconcile`)).statusCode).toBe(200);
    expect((await booking.detail()).milestones[0]).toMatchObject({
      status: 'PAID',
      remainingAmount: '0.00',
    });
    expect((await booking.confirm()).statusCode).toBe(200);
  });

  it('keeps settlement discounts separate from cash, blocks overpayment, and preserves cancellation rules', async () => {
    const booking = await fixture();
    const adjustment = await create(
      '/settlement-adjustments',
      { invoiceId: booking.invoiceId, amount: '100.01', reason: 'Discount', date },
      randomUUID(),
    );
    const detail = await booking.detail();
    expect(detail.invoice.dueAmount).toBe('0.00');
    expect(detail.milestones[0]).toMatchObject({ status: 'PENDING', remainingAmount: '30.01' });
    expect((await booking.confirm()).statusCode).toBe(409);
    expect(
      (
        await call(
          'POST',
          '/receipts',
          {
            invoiceId: booking.invoiceId,
            amount: '0.01',
            receivedDate: date,
            method: 'CASH',
            details: {},
            status: 'CONFIRMED',
          },
          randomUUID(),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', `/settlement-adjustments/${adjustment.id}/reverse`, {
          reason: 'Withdraw discount',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await call('POST', `/invoices/${booking.invoiceId}/cancel`, { reason: 'Cancelled' }))
        .statusCode,
    ).toBe(200);
    expect((await booking.confirm()).statusCode).toBe(409);
    expect((await booking.detail()).milestones[0]).toMatchObject({
      status: 'PENDING',
      remainingAmount: '30.01',
    });
  });
  async function reviewFixture(
    options: { amount?: string; currency?: string; legacy?: boolean } = {},
  ) {
    const booking = await fixture(new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10));
    const orderId = await booking.checkout();
    setAttempt(
      orderId,
      'SUCCESS',
      { amount: options.amount ?? '30.00', currency: options.currency ?? 'INR' },
      'PAID',
    );
    await services.core.commercial.reconcile(orderId);
    const saved = await rows(orderId);
    if (options.legacy)
      await database.db
        .update(paymentAttempts)
        .set({ reviewReasons: [] })
        .where(eq(paymentAttempts.id, saved.attempts[0]!.id));
    const inspect = () => services.core.paymentReview.inspect(saved.order.id);
    const resolve = async (
      action: ResolutionInput['action'] = 'APPLY_TO_LINKED_INVOICE',
      extra: Record<string, unknown> = {},
      key = randomUUID(),
    ) => {
      const view = await inspect();
      return call(
        'POST',
        `/payment-attempts/${saved.attempts[0]!.id}/resolve`,
        {
          action,
          version: view.version,
          note: 'Verified payment and accounting evidence',
          ...extra,
        },
        key,
      );
    };
    return {
      ...booking,
      orderId,
      internalId: saved.order.id,
      attemptId: saved.attempts[0]!.id,
      inspect,
      resolve,
    };
  }
  it('inspects historical unknown review reasons without inventing them and resolves an applicable amount mismatch', async () => {
    const f = await reviewFixture({ legacy: true });
    const before = await f.inspect();
    expect(before.attempts[0]!.reviewReasons).toEqual([
      { code: 'UNKNOWN_LEGACY_REASON', details: {} },
    ]);
    expect(
      before.attempts[0]!.actions.find((a) => a.action === 'APPLY_TO_LINKED_INVOICE')!.allowed,
    ).toBe(true);
    const result = await f.resolve();
    expect(result.statusCode, result.body).toBe(200);
    const after = await rows(f.orderId);
    expect(after.attempts[0]).toMatchObject({ status: 'SUCCESS', accountingStatus: 'APPLIED' });
    expect(after.order.status).toBe('PAID');
    const details = await f.detail();
    expect(details.invoice.receivedAmount).toBe('30.00');
    expect(details.invoice.receipts[0]).toMatchObject({ receivedDate: date });
    const review = await f.inspect();
    expect(review.history).toHaveLength(1);
    expect(review.history[0]).toMatchObject({
      action: 'APPLY_TO_LINKED_INVOICE',
      note: 'Verified payment and accounting evidence',
      amount: '30.00',
    });
    expect(JSON.stringify(review)).not.toContain('sessionId');
    expect(JSON.stringify(review)).not.toContain('requestHash');
  });
  it('links an explicitly selected authoritative backend receipt and never attributes a different payment', async () => {
    const f = await reviewFixture();
    const { attempts } = await rows(f.orderId);
    const payment = attempts[0]!;
    const booking = (
      await database.db.select().from(commercialBookings).where(eq(commercialBookings.id, f.id))
    )[0]!;
    const receipt = await services.core.billing.createReceipt(
      {
        invoiceId: f.invoiceId,
        amount: payment.amount,
        receivedDate: date,
        method: 'GATEWAY',
        details: { reference: `cashfree:${payment.providerPaymentId}` },
        status: 'CONFIRMED',
      },
      gatewayReceiptKey('cashfree', payment.providerPaymentId),
      booking.createdBy,
    );
    expect((await f.inspect()).attempts[0]!.matchingReceipts.map((r) => r.id)).toContain(
      receipt.id,
    );
    const bad = await f.resolve('LINK_EXISTING_RECEIPT', { receiptId: randomUUID() });
    expect(bad.statusCode).toBe(409);
    const linked = await f.resolve('LINK_EXISTING_RECEIPT', { receiptId: receipt.id });
    expect(linked.statusCode, linked.body).toBe(200);
    expect((await f.detail()).invoice.receipts).toHaveLength(1);
    const report = await services.core.paymentsReport.payments({ q: f.orderId });
    expect(report.total).toBe(1);
    expect(report.items[0]).toMatchObject({
      receiptId: receipt.id,
      source: 'GATEWAY',
      providerConfirmedReviewAmount: '0.00',
    });
    // A new order cannot claim the same receipt/payment identity.
    const second = await reviewFixture();
    expect(
      (await second.resolve('LINK_EXISTING_RECEIPT', { receiptId: receipt.id })).statusCode,
    ).toBe(409);
  });
  it('persists actual mismatch, overpayment and invoice eligibility reasons and keeps unsafe funds unresolved', async () => {
    const mismatch = await reviewFixture({ currency: 'USD', amount: '30.00' });
    expect((await mismatch.inspect()).attempts[0]!.reviewReasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['AMOUNT_MISMATCH', 'CURRENCY_MISMATCH']),
    );
    expect((await mismatch.resolve()).statusCode).toBe(409);
    const over = await fixture();
    const orderId = await over.checkout();
    await over.receipt('80.00');
    setAttempt(orderId, 'SUCCESS', {}, 'PAID');
    await services.core.commercial.reconcile(orderId);
    expect((await rows(orderId)).attempts[0]!.reviewReasons[0]!.code).toBe('OVERPAYMENT');
    const f = await reviewFixture();
    await database.db
      .update(invoices)
      .set({ status: 'CANCELLED' })
      .where(eq(invoices.id, f.invoiceId));
    const view = await f.inspect();
    expect(
      view.attempts[0]!.actions.find((a) => a.action === 'APPLY_TO_LINKED_INVOICE')!.blockers,
    ).toContain('INVOICE_NOT_ISSUED');
    expect((await f.resolve()).statusCode).toBe(409);
    await database.db
      .update(commercialBookings)
      .set({ invoiceId: null })
      .where(eq(commercialBookings.id, f.id));
    expect((await f.inspect()).attempts[0]!.actions[0]!.blockers).toContain('INVOICE_MISSING');
    const b = await fixture();
    const bo = await b.checkout();
    await database.db
      .update(commercialBookings)
      .set({ status: 'CANCELLED' })
      .where(eq(commercialBookings.id, b.id));
    setAttempt(bo, 'SUCCESS', {}, 'PAID');
    await services.core.commercial.reconcile(bo);
    expect((await rows(bo)).attempts[0]!.reviewReasons[0]!.code).toBe('BOOKING_INELIGIBLE');
    const i = await fixture();
    const io = await i.checkout();
    await database.db
      .update(invoices)
      .set({ status: 'CANCELLED' })
      .where(eq(invoices.id, i.invoiceId));
    setAttempt(io, 'SUCCESS', {}, 'PAID');
    await services.core.commercial.reconcile(io);
    expect((await rows(io)).attempts[0]!.reviewReasons[0]!.code).toBe('INVOICE_NOT_ISSUED');
  });
  const refundInput = (amount: string, currency = 'INR') => ({
    providerRefundReference: `external-${randomUUID()}`,
    amount,
    currency,
    completedAt: new Date(Date.parse(`${date}T12:01:00+05:30`) + 60000).toISOString(),
    verification: {
      kind: 'STAFF_ATTESTATION',
      evidenceReference: 'Bank settlement evidence: verified refund statement',
      attested: true,
    },
  });
  it('records complete externally refunded funds with an immutable staff attestation and unblocks safe checkout', async () => {
    const f = await reviewFixture();
    expect(
      (await f.resolve('RECORD_VERIFIED_EXTERNAL_REFUND', { refund: refundInput('1.00') }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await f.resolve('RECORD_VERIFIED_EXTERNAL_REFUND', {
          refund: {
            ...refundInput('30.00'),
            verification: {
              kind: 'STAFF_ATTESTATION',
              evidenceReference: 'statement',
              attested: false,
            },
          },
        })
      ).statusCode,
    ).toBe(400);
    const completed = await f.resolve('RECORD_VERIFIED_EXTERNAL_REFUND', {
      refund: refundInput('30.00'),
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect((await rows(f.orderId)).attempts[0]).toMatchObject({
      status: 'SUCCESS',
      accountingStatus: 'REFUNDED',
    });
    expect((await f.inspect()).history[0]!.refund!.verification.kind).toBe('STAFF_ATTESTATION');
    expect((await f.detail()).invoice.receivedAmount).toBe('0.00');
    const report = await services.core.paymentsReport.payments({ q: f.orderId });
    expect(report.summary).toMatchObject({
      confirmedReceiptAmount: '0.00',
      providerConfirmedReviewAmount: '0.00',
      recordedExternalRefundAmount: '30.00',
    });
    expect(report.items[0]).toMatchObject({ gatewayStatus: 'REFUNDED' });
    const next = await f.checkout();
    expect(next).not.toBe(f.orderId);
    const [decision] = await database.db
      .select()
      .from(paymentAttemptResolutions)
      .where(eq(paymentAttemptResolutions.attemptId, f.attemptId));
    await expect(
      database.db
        .update(paymentAttemptResolutions)
        .set({ note: 'erase history' })
        .where(eq(paymentAttemptResolutions.id, decision!.id)),
    ).rejects.toThrow();
    await expect(
      database.db
        .delete(paymentAttemptResolutions)
        .where(eq(paymentAttemptResolutions.id, decision!.id)),
    ).rejects.toThrow();
  });
  it('keeps an additional success unresolved until its full refund and preserves the canonical paid receipt', async () => {
    const f = await fixture();
    const orderId = await f.checkout();
    setAttempt(orderId, 'SUCCESS', {}, 'PAID');
    await services.core.commercial.reconcile(orderId);
    const original = await rows(orderId);
    setAttempt(orderId, 'SUCCESS', { paymentId: `extra-${orderId}` }, 'PAID');
    await services.core.commercial.reconcile(orderId);
    const extra = (await rows(orderId)).attempts.find(
      (a) => a.providerPaymentId === `extra-${orderId}`,
    )!;
    const before = await services.core.paymentReview.inspect(original.order.id);
    const attempted = before.attempts.find((a) => a.id === extra.id)!;
    expect(attempted.reviewReasons.map((r) => r.code)).toContain('ADDITIONAL_SUCCESS');
    expect(attempted.actions[0]!.allowed).toBe(false);
    const blocked = await call(
      'POST',
      `/public/bookings/${f.accessToken}/milestones/${(await f.detail()).milestones[1]!.id}/checkout`,
    );
    expect(blocked.statusCode).toBe(409);
    const result = await call(
      'POST',
      `/payment-attempts/${extra.id}/resolve`,
      {
        action: 'RECORD_VERIFIED_EXTERNAL_REFUND',
        version: before.version,
        note: 'Verified full return of duplicate funds',
        refund: refundInput('30.01'),
      },
      randomUUID(),
    );
    expect(result.statusCode, result.body).toBe(200);
    const after = await rows(orderId);
    expect(after.order).toMatchObject({
      status: 'PAID',
      receiptId: original.order.receiptId,
      reviewRequiredAt: null,
    });
    expect((await f.detail()).invoice.receivedAmount).toBe('30.01');
    await f.checkout(1);
    const r = await services.core.paymentsReport.payments({ q: orderId });
    expect(r.summary).toMatchObject({
      confirmedReceiptAmount: '30.01',
      providerConfirmedReviewAmount: '0.00',
      recordedExternalRefundAmount: '30.01',
    });
  });
  it('provides idempotent retries, detects conflicting/stale decisions and serializes concurrent resolutions', async () => {
    const f = await reviewFixture();
    const view = await f.inspect();
    const key = randomUUID();
    const body = {
      action: 'APPLY_TO_LINKED_INVOICE',
      version: view.version,
      note: 'Verified reviewed collection',
    };
    const url = `/payment-attempts/${f.attemptId}/resolve`;
    const [one, two] = await Promise.all([
      call('POST', url, body, key),
      call('POST', url, body, key),
    ]);
    expect(one.statusCode, one.body).toBe(200);
    expect(two.statusCode, two.body).toBe(200);
    expect(one.json<{ data: { resolution: { id: string } } }>().data.resolution.id).toBe(
      two.json<{ data: { resolution: { id: string } } }>().data.resolution.id,
    );
    expect((await f.detail()).invoice.receipts).toHaveLength(1);
    expect(
      (await call('POST', url, { ...body, note: 'Changed decision' }, key)).json<{
        error: { code: string };
      }>().error.code,
    ).toBe('PAYMENT_RESOLUTION_IDEMPOTENCY_CONFLICT');
    const stale = await reviewFixture();
    const old = await stale.inspect();
    await stale.receipt('1.00');
    const changed = await call(
      'POST',
      `/payment-attempts/${stale.attemptId}/resolve`,
      { ...body, version: old.version },
      randomUUID(),
    );
    expect(changed.json<{ error: { code: string } }>().error.code).toBe('PAYMENT_REVIEW_STALE');
    const race = await reviewFixture();
    const current = await race.inspect();
    const outcomes = await Promise.all(
      [1, 2].map(() =>
        call(
          'POST',
          `/payment-attempts/${race.attemptId}/resolve`,
          { ...body, version: current.version },
          randomUUID(),
        ),
      ),
    );
    expect(outcomes.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await race.detail()).invoice.receipts).toHaveLength(1);
  });
  it('serializes invoice settlements with resolution and rejects overspending the balance', async () => {
    const f = await reviewFixture({ amount: '80.00' });
    const view = await f.inspect();
    const booking = (
      await database.db.select().from(commercialBookings).where(eq(commercialBookings.id, f.id))
    )[0]!;
    const outcomes = await Promise.allSettled([
      services.core.paymentReview.resolve(
        f.attemptId,
        { action: 'APPLY_TO_LINKED_INVOICE', version: view.version, note: 'Apply verified funds' },
        randomUUID(),
        booking.createdBy,
      ),
      services.core.billing.createReceipt(
        {
          invoiceId: f.invoiceId,
          receivedDate: date,
          amount: '80.00',
          method: 'CASH',
          details: {},
          status: 'CONFIRMED',
        },
        randomUUID(),
        booking.createdBy,
      ),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.detail()).invoice.receivedAmount).toBe('80.00');
  });
  it('fences a provider observation begun before a staff resolution and never reapplies refunded funds', async () => {
    const f = await reviewFixture();
    const originalInspect = provider.inspectOrder;
    let release!: () => void;
    let began!: () => void;
    const ready = new Promise<void>((r) => {
      began = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    provider.inspectOrder = async (id) => {
      const snapshot = await originalInspect(id);
      began();
      await gate;
      return snapshot;
    };
    const polling = services.core.commercial.reconcile(f.orderId);
    await ready;
    try {
      expect(
        (await f.resolve('RECORD_VERIFIED_EXTERNAL_REFUND', { refund: refundInput('30.00') }))
          .statusCode,
      ).toBe(200);
    } finally {
      release();
      provider.inspectOrder = originalInspect;
    }
    await polling;
    await services.core.commercial.receivePaymentWebhook(f.orderId, `resolved-${randomUUID()}`);
    await makeDue(f.orderId);
    await processPaymentReconciliation(database.db, services.core.commercial);
    expect((await rows(f.orderId)).order.status).toBe('REFUNDED');
    expect((await rows(f.orderId)).attempts[0]!.accountingStatus).toBe('REFUNDED');
    expect((await f.detail()).invoice.receipts).toHaveLength(0);
    expect((await f.inspect()).history).toHaveLength(1);
  });
  it('does not treat reversed gateway receipts as refunds or allow another checkout while those funds are unaccounted', async () => {
    const f = await fixture();
    const orderId = await f.checkout();
    setAttempt(orderId, 'SUCCESS', {}, 'PAID');
    await services.core.commercial.reconcile(orderId);
    const saved = await rows(orderId);
    await database.db
      .update(receipts)
      .set({ status: 'REVERSED', reversalReason: 'Historic reversal' })
      .where(eq(receipts.id, saved.order.receiptId!));
    const review = await services.core.paymentReview.inspect(saved.order.id);
    expect(review.attempts[0]!.receiptAccountingState).toBe('REVERSED_WITHOUT_REFUND');
    expect(review.history).toHaveLength(0);
    const report = await services.core.paymentsReport.payments({ q: orderId });
    expect(report.summary).toMatchObject({
      confirmedReceiptAmount: '0.00',
      providerConfirmedReviewAmount: '30.01',
      recordedExternalRefundAmount: '0.00',
    });
    const response = await call(
      'POST',
      `/public/bookings/${f.accessToken}/milestones/${(await f.detail()).milestones[0]!.id}/checkout`,
    );
    expect(response.statusCode).toBe(409);
    const refund = await call(
      'POST',
      `/payment-attempts/${saved.attempts[0]!.id}/resolve`,
      {
        action: 'RECORD_VERIFIED_EXTERNAL_REFUND',
        version: review.version,
        note: 'Recorded evidence of returned historic funds',
        refund: refundInput('30.01'),
      },
      randomUUID(),
    );
    expect(refund.statusCode, refund.body).toBe(200);
  });
  it('rolls back all accounting changes when receipt creation or resolution audit fails', async () => {
    const f = await reviewFixture();
    const view = await f.inspect();
    const booking = (
      await database.db.select().from(commercialBookings).where(eq(commercialBookings.id, f.id))
    )[0]!;
    const input = {
      action: 'APPLY_TO_LINKED_INVOICE' as const,
      version: view.version,
      note: 'Apply only atomically',
    };
    const createSpy = vi
      .spyOn(services.core.billing, 'createReceiptInTransaction')
      .mockRejectedValueOnce(new Error('Injected receipt failure'));
    try {
      await expect(
        services.core.paymentReview.resolve(f.attemptId, input, randomUUID(), booking.createdBy),
      ).rejects.toThrow('Injected receipt failure');
    } finally {
      createSpy.mockRestore();
    }
    const originalAudit = auditModule.audit;
    const auditSpy = vi.spyOn(auditModule, 'audit').mockImplementation(async (...args) => {
      if (args[3] === 'payment_attempt_resolution') throw new Error('Injected audit failure');
      return originalAudit(...args);
    });
    try {
      await expect(
        services.core.paymentReview.resolve(f.attemptId, input, randomUUID(), booking.createdBy),
      ).rejects.toThrow('Injected audit failure');
    } finally {
      auditSpy.mockRestore();
    }
    expect((await f.detail()).invoice.receipts).toHaveLength(0);
    expect((await rows(f.orderId)).attempts[0]!.accountingStatus).toBe('REVIEW_REQUIRED');
    expect((await f.inspect()).history).toHaveLength(0);
    expect((await f.resolve()).statusCode).toBe(200);
  });
  it('enforces staff inspection, administrator resolution, public rejection and explicit reconciliation identifier contracts', async () => {
    const f = await reviewFixture();
    const current = await f.inspect();
    const body = {
      action: 'APPLY_TO_LINKED_INVOICE',
      version: current.version,
      note: 'Financial decision',
    };
    for (const role of ['CORE_REPORT_VIEWER', 'CORE_DATA_ENTRY', 'ADMIN', 'CUSTOMER'] as const) {
      const password = 'Review-role-password-123';
      const username = `review-${role}-${randomUUID()}`;
      const [account] = await database.db
        .insert(authAccounts)
        .values({
          role,
          username,
          email: `${username}@example.com`,
          displayName: 'Review test',
          passwordHash: await passwordHasher.hash(password),
        })
        .returning();
      // Use a real authenticated session even for roles that cannot use Core login.
      const token = randomUUID() + randomUUID();
      const { authSessions } = await import('../src/database/schema/authentication.js');
      await database.db.insert(authSessions).values({
        accountId: account!.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 3600000),
        absoluteExpiresAt: new Date(Date.now() + 3600000),
      });
      const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl });
      const headers = {
        cookie: `${config.sessionCookieName}=${token}`,
        'idempotency-key': randomUUID(),
      };
      const inspect = await app.inject({
        method: 'GET',
        url: `/api/v1/core/payment-orders/${f.internalId}/review`,
        headers,
        remoteAddress: randomUUID(),
      });
      expect(inspect.statusCode, inspect.body).toBe(role.startsWith('CORE_') ? 200 : 403);
      const decision = await app.inject({
        method: 'POST',
        url: `/api/v1/core/payment-attempts/${f.attemptId}/resolve`,
        headers,
        payload: body,
        remoteAddress: randomUUID(),
      });
      expect(decision.statusCode, decision.body).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/core/payment-orders/${f.internalId}/review`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/core/payment-attempts/${f.attemptId}/resolve`,
          headers: { 'idempotency-key': randomUUID() },
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await call(
          'POST',
          `/public/bookings/${f.accessToken}/payment-attempts/${f.attemptId}/resolve`,
          body,
          randomUUID(),
        )
      ).statusCode,
    ).toBe(404);
    expect((await call('POST', `/payment-orders/${f.internalId}/reconcile`)).statusCode).toBe(400);
    expect((await call('POST', `/payment-orders/${f.internalId}/reconcile-by-id`)).statusCode).toBe(
      200,
    );
    expect((await call('POST', `/payment-orders/${f.orderId}/reconcile`)).statusCode).toBe(200);
    expect(
      (await call('POST', `/public/bookings/${f.accessToken}/orders/${f.orderId}/reconcile`))
        .statusCode,
    ).toBe(200);
  });
  it('records receipt conflicts and validation reasons, and rejects refund recording while the identified receipt is still confirmed', async () => {
    const b = await fixture();
    const orderId = await b.checkout();
    const booking = (
      await database.db.select().from(commercialBookings).where(eq(commercialBookings.id, b.id))
    )[0]!;
    const priorDate = new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
    const paymentId = `attempt-${orderId}`;
    const receipt = await services.core.billing.createReceipt(
      {
        invoiceId: b.invoiceId,
        amount: '30.01',
        receivedDate: priorDate,
        method: 'GATEWAY',
        details: { reference: `cashfree:${paymentId}` },
        status: 'CONFIRMED',
      },
      gatewayReceiptKey('cashfree', paymentId),
      booking.createdBy,
    );
    setAttempt(orderId, 'SUCCESS', {}, 'PAID');
    await services.core.commercial.reconcile(orderId);
    const saved = await rows(orderId);
    expect(saved.attempts[0]!.reviewReasons[0]!.code).toBe('RECEIPT_IDEMPOTENCY_CONFLICT');
    const view = await services.core.paymentReview.inspect(saved.order.id);
    expect(
      view.attempts[0]!.actions.find((a) => a.action === 'RECORD_VERIFIED_EXTERNAL_REFUND')!
        .blockers,
    ).toContain('RECEIPT_NOT_REVERSED');
    expect(view.attempts[0]!.matchingReceipts.map((r) => r.id)).toContain(receipt.id);
    // Attribute the matching receipt to a different order; link eligibility must disappear.
    const [other] = await database.db
      .insert(paymentOrders)
      .values({
        milestoneId: saved.order.milestoneId,
        provider: 'cashfree',
        providerOrderId: `different-${randomUUID()}`,
        amount: '30.01',
        status: 'PAID',
        receiptId: receipt.id,
      })
      .returning();
    try {
      expect(
        (await services.core.paymentReview.inspect(saved.order.id)).attempts[0]!.actions.find(
          (a) => a.action === 'LINK_EXISTING_RECEIPT',
        )!.allowed,
      ).toBe(false);
    } finally {
      await database.db.delete(paymentOrders).where(eq(paymentOrders.id, other!.id));
    }
    const linked = await call(
      'POST',
      `/payment-attempts/${saved.attempts[0]!.id}/resolve`,
      {
        action: 'LINK_EXISTING_RECEIPT',
        version: (await services.core.paymentReview.inspect(saved.order.id)).version,
        note: 'Confirmed prior backend receipt identity and date difference',
        receiptId: receipt.id,
      },
      randomUUID(),
    );
    expect(linked.statusCode, linked.body).toBe(200);
    const invalid = await fixture();
    const io = await invalid.checkout();
    setAttempt(io, 'SUCCESS', {}, 'PAID');
    const spy = vi.spyOn(services.core.billing, 'createReceiptInTransaction').mockRejectedValueOnce(
      new AppError({
        code: 'CORE_VALIDATION_FAILED',
        message: 'Invalid receipt facts',
        statusCode: 422,
      }),
    );
    try {
      await services.core.commercial.reconcile(io);
    } finally {
      spy.mockRestore();
    }
    expect((await rows(io)).attempts[0]!.reviewReasons[0]!.code).toBe('RECEIPT_VALIDATION_FAILED');
  });
  it('does not reuse external refund references, accept wrong currencies or clear another unresolved success', async () => {
    const first = await reviewFixture();
    const refund = refundInput('30.00');
    expect((await first.resolve('RECORD_VERIFIED_EXTERNAL_REFUND', { refund })).statusCode).toBe(
      200,
    );
    const second = await reviewFixture();
    expect(
      (
        await second.resolve('RECORD_VERIFIED_EXTERNAL_REFUND', {
          refund: { ...refund, currency: 'USD' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await second.resolve('RECORD_VERIFIED_EXTERNAL_REFUND', { refund })).json<{
        error: { code: string };
      }>().error.code,
    ).toBe('PAYMENT_REFUND_REFERENCE_USED');
    setAttempt(
      second.orderId,
      'SUCCESS',
      { paymentId: `remaining-${second.orderId}`, amount: '10.00' },
      'PAID',
    );
    await services.core.commercial.reconcile(second.orderId);
    expect(
      (await second.resolve('RECORD_VERIFIED_EXTERNAL_REFUND', { refund: refundInput('30.00') }))
        .statusCode,
    ).toBe(200);
    const report = await services.core.paymentsReport.payments({ q: second.orderId });
    expect(report.items[0]).toMatchObject({
      gatewayStatus: 'REVIEW_REQUIRED',
      providerConfirmedReviewAmount: '10.00',
      recordedExternalRefundAmount: '30.00',
    });
    const blocked = await call(
      'POST',
      `/public/bookings/${second.accessToken}/milestones/${(await second.detail()).milestones[0]!.id}/checkout`,
    );
    expect(blocked.statusCode).toBe(409);
    const csv = await call('GET', `/reports/payments/export?q=${second.orderId}`);
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain(second.attemptId);
    expect(csv.body).toContain('RECORD_VERIFIED_EXTERNAL_REFUND');
    expect(csv.body).toContain('ORDER_ALREADY_UNDER_REVIEW');
    expect(csv.body).not.toContain('idempotencyKey');
  });
  it('keeps foreign currency refund facts visible without including them in INR receipt or refund totals', async () => {
    const f = await reviewFixture({ currency: 'USD' });
    const response = await f.resolve('RECORD_VERIFIED_EXTERNAL_REFUND', {
      refund: refundInput('30.00', 'USD'),
    });
    expect(response.statusCode, response.body).toBe(200);
    const report = await services.core.paymentsReport.payments({ q: f.orderId });
    expect(report.summary).toMatchObject({
      confirmedReceiptAmount: '0.00',
      providerConfirmedReviewAmount: '0.00',
      recordedExternalRefundAmount: '0.00',
    });
    expect((report.items[0]!.resolutions as { currency: string }[])[0]!.currency).toBe('USD');
  });
});
