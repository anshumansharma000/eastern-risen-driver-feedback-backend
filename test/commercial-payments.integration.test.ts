import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices, type ApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import { authAccounts } from '../src/database/schema/accounts.js';
import { passwordHasher } from '../src/modules/auth/password.js';
import { CommercialService } from '../src/modules/core/application/commercial.service.js';
import type { PaymentProvider } from '../src/modules/core/application/payment-provider.js';
import { paymentOrders } from '../src/modules/core/persistence/commercial.schema.js';

interface RecordEnvelope {
  data: { id: string; version: number };
  error: { code: string };
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
const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('commercial milestone payment lifecycle', () => {
  let database: DatabaseClient, app: FastifyInstance, services: ApplicationServices;
  let companyId: string, customerId: string, categoryId: string, bankId: string, cookie: string;
  const suffix = randomUUID().slice(0, 8);
  const date = new Date().toISOString().slice(0, 10);
  const verified = new Map<string, Awaited<ReturnType<PaymentProvider['successfulPayment']>>>();
  const amounts = new Map<string, string>();
  const provider: PaymentProvider = {
    name: 'cashfree',
    createOrder: async (input) => {
      amounts.set(input.orderId, input.amount);
      return { sessionId: `session-${input.orderId}` };
    },
    successfulPayment: async (id) => verified.get(id) ?? null,
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
  async function fixture() {
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
      invoiceDate: date,
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
    await app?.close();
    await database?.close();
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
});
