import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import { authAccounts } from '../src/database/schema/accounts.js';
import { passwordHasher } from '../src/modules/auth/password.js';
import {
  commercialBookings,
  paymentMilestones,
  paymentOrders,
  paymentAttempts,
} from '../src/modules/core/persistence/commercial.schema.js';
import { invoices, receipts } from '../src/modules/core/persistence/billing.schema.js';
import { customers, companies } from '../src/modules/core/persistence/masters.schema.js';

interface PaymentRow {
  id: string;
  source: string;
  amount: string;
  receiptId: string | null;
  receiptStatus: string | null;
  receiptNumber: string | null;
  gatewayStatus: string | null;
  paymentOrderId: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  reportDate: string;
  method: string | null;
  reversalReason: string | null;
  attempts: { status: string }[];
}
interface Report {
  data: PaymentRow[];
  summary: {
    total: number;
    manualCount: number;
    gatewayCount: number;
    confirmedReceiptCount: number;
    confirmedReceiptAmount: string;
    pendingReceiptCount: number;
    pendingReceiptAmount: string;
    reversedReceiptCount: number;
    reversedReceiptAmount: string;
    providerConfirmedReviewAmount: string;
    gatewayStatusBreakdown: { status: string; count: number; amount: string }[];
  };
  pagination: { page: number; pageSize: number; total: number };
  meta: { from: string | null; to: string | null; dateBasis: string };
}
const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration('unified staff payments report', () => {
  let app: FastifyInstance, database: DatabaseClient;
  let cookie: string, viewerCookie: string, operatorCookie: string, forbiddenCookie: string;
  let companyId: string,
    customerId: string,
    categoryId: string,
    invoiceId: string,
    bookingId: string;
  let paidOrderId: string, reviewOrderId: string, reversedOrderId: string;
  let otherReceiptId: string;
  const suffix = randomUUID().slice(0, 8);
  const call = (
    method: NonNullable<InjectOptions['method']>,
    path: string,
    payload?: unknown,
    selectedCookie = cookie,
  ) =>
    app.inject({
      method,
      url: `/api/v1/core${path}`,
      headers: { cookie: selectedCookie },
      remoteAddress: randomUUID(),
      ...(payload === undefined
        ? {}
        : { payload: payload as NonNullable<InjectOptions['payload']> }),
    });
  async function create(path: string, payload: unknown) {
    const response = await call('POST', path, payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ data: { id: string; version: number } }>().data;
  }
  async function report(query = '') {
    const response = await call('GET', `/reports/payments?companyId=${companyId}&${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Report>();
  }
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DATABASE_SSL_MODE: 'disable',
    });
    database = createDatabaseClient(config);
    const password = 'Payments-report-test-123';
    const passwordHash = await passwordHasher.hash(password);
    const accounts = await database.db
      .insert(authAccounts)
      .values([
        {
          role: 'CORE_ADMIN',
          username: `pr-admin-${suffix}`,
          email: `pr-admin-${suffix}@example.com`,
          displayName: 'Report Admin',
          passwordHash,
        },
        {
          role: 'CORE_REPORT_VIEWER',
          username: `pr-viewer-${suffix}`,
          email: `pr-viewer-${suffix}@example.com`,
          displayName: 'Report Viewer',
          passwordHash,
        },
        {
          role: 'CORE_DATA_ENTRY',
          username: `pr-operator-${suffix}`,
          email: `pr-operator-${suffix}@example.com`,
          displayName: 'Report Operator',
          passwordHash,
        },
        {
          role: 'ADMIN',
          email: `pr-feedback-${suffix}@example.com`,
          displayName: 'Feedback Admin',
          passwordHash,
        },
      ])
      .returning();
    app = await buildApp({
      services: createApplicationServices(database.db, config),
      exposeDocs: false,
    });
    async function login(username: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/core/login',
        payload: { username, password },
      });
      expect(response.statusCode, response.body).toBe(200);
      return String(response.headers['set-cookie']).split(';')[0]!;
    }
    cookie = await login(`pr-admin-${suffix}`);
    viewerCookie = await login(`pr-viewer-${suffix}`);
    operatorCookie = await login(`pr-operator-${suffix}`);
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: `pr-feedback-${suffix}@example.com`, password },
    });
    expect(forbidden.statusCode).toBe(200);
    forbiddenCookie = String(forbidden.headers['set-cookie']).split(';')[0]!;
    companyId = (
      await create('/companies', {
        name: `Payments Company ${suffix}`,
        address: 'Address',
        state: 'ODISHA',
        country: 'INDIA',
      })
    ).id;
    customerId = (
      await create('/customers', {
        name: `Payments Customer ${suffix}`,
        category: 'AGENT',
        state: 'ODISHA',
        country: 'INDIA',
      })
    ).id;
    categoryId = (
      await create('/service-categories', { name: `Payments Service ${suffix}`, code: '9985' })
    ).id;
    const invoice = await create('/invoices', {
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      invoiceDate: '2026-10-08',
      guestDisplayText: 'Report Guest',
      serviceProvidedAt: 'ODISHA',
      placeOfSupplyState: 'ODISHA',
      placeOfSupplyCountry: 'INDIA',
      bankAccountIds: [],
      lines: [
        {
          description: 'Report',
          amount: '10000.00',
          taxTreatment: 'NON_TAXABLE',
          taxComponents: [],
        },
      ],
    });
    invoiceId = invoice.id;
    const issue = await call('POST', `/invoices/${invoiceId}/issue`, { version: invoice.version });
    expect(issue.statusCode, issue.body).toBe(200);
    const [booking] = await database.db
      .insert(commercialBookings)
      .values({
        reference: `PAYBOOK-${suffix}`,
        companyId,
        customerId,
        serviceCategoryId: categoryId,
        title: 'Report booking',
        status: 'CANCELLED',
        invoiceId,
        createdBy: accounts[0]!.id,
      })
      .returning();
    bookingId = booking!.id;
    const [milestone] = await database.db
      .insert(paymentMilestones)
      .values({ bookingId, position: 1, label: 'Full', amount: '10000.00', dueOn: '2026-10-08' })
      .returning();
    const receipt = async (
      amount: string,
      status: 'CONFIRMED' | 'PENDING' | 'REVERSED',
      method: 'CASH' | 'UPI' | 'CARD' | 'GATEWAY',
      date = '2026-10-07',
    ) => {
      const id = randomUUID();
      const [row] = await database.db
        .insert(receipts)
        .values({
          id,
          invoiceId,
          companyId,
          receiptNumber: `R/${suffix}/${id}`,
          financialYear: '2627',
          receivedDate: date,
          amount,
          method,
          status,
          details: {
            reference: `cashfree:looks-like-gateway-${suffix}`,
            cardLastFour: '1234',
            ...{ sessionId: 'SECRET-DETAIL' },
          },
          idempotencyKey: id,
          requestHash: 'test',
          createdBy: accounts[0]!.id,
          createdAt: new Date('2026-10-07T09:00:00Z'),
          reversalReason: status === 'REVERSED' ? 'Accounting correction' : null,
        })
        .returning();
      return row!;
    };
    await receipt('0.10', 'CONFIRMED', 'CASH');
    await receipt('0.20', 'CONFIRMED', 'CASH');
    await receipt('50.00', 'PENDING', 'UPI', '2026-10-06');
    await receipt('20.00', 'REVERSED', 'CARD', '2026-10-08');
    await receipt('40.00', 'CONFIRMED', 'GATEWAY'); // No authoritative link: stays MANUAL.
    for (const [index, status] of [
      'CREATING',
      'READY',
      'PAID',
      'EXPIRED',
      'TERMINATED',
      'REVIEW_REQUIRED',
      'PAID',
    ].entries()) {
      const amount = ['70.00', '60.00', '100.00', '80.00', '90.00', '200.00', '30.00'][index]!;
      const linked =
        status === 'PAID'
          ? await receipt(amount, index === 6 ? 'REVERSED' : 'CONFIRMED', 'GATEWAY', '2026-10-06')
          : null;
      const id = randomUUID();
      const [order] = await database.db
        .insert(paymentOrders)
        .values({
          id,
          milestoneId: milestone!.id,
          provider: 'cashfree',
          providerOrderId: `ORDER-${suffix}-${index}`,
          amount,
          status,
          providerStatus: status === 'PAID' || status === 'REVIEW_REQUIRED' ? 'PAID' : 'ACTIVE',
          providerPaymentId:
            status === 'PAID' || status === 'REVIEW_REQUIRED' ? `PAYMENT-${suffix}-${index}` : null,
          receiptId: linked?.id ?? null,
          sessionId: 'SECRET-CHECKOUT',
          createdAt: new Date(
            index === 0
              ? '2020-01-01T00:00:00Z'
              : index === 1
                ? '2026-10-07T18:30:00Z'
                : '2026-10-07T09:00:00Z',
          ),
          paidAt:
            status === 'PAID'
              ? new Date(index === 6 ? '2026-10-07T10:00:00Z' : '2026-10-06T18:30:00Z')
              : status === 'REVIEW_REQUIRED'
                ? new Date('2026-10-07T18:29:59Z')
                : null,
        })
        .returning();
      if (index === 2) paidOrderId = id;
      if (index === 5) reviewOrderId = id;
      if (index === 6) reversedOrderId = id;
      if (['PAID', 'REVIEW_REQUIRED', 'READY'].includes(status))
        await database.db.insert(paymentAttempts).values({
          orderId: order!.id,
          provider: 'cashfree',
          providerPaymentId: `ATTEMPT-${suffix}-${index}`,
          status: status === 'READY' ? 'PENDING' : 'SUCCESS',
          rawStatus: status === 'READY' ? 'PENDING' : 'SUCCESS',
          amount,
          currency: 'INR',
          initiatedAt: new Date('2026-10-07T09:00:00Z'),
          accountingStatus:
            status === 'REVIEW_REQUIRED'
              ? 'REVIEW_REQUIRED'
              : status === 'PAID'
                ? 'APPLIED'
                : 'UNAPPLIED',
          receiptId: linked?.id ?? null,
        });
    }
    // A second company/customer proves the default is not scoped to one party.
    const otherCompanyId = (
      await create('/companies', {
        name: `Other Payments Company ${suffix}`,
        address: 'Address',
        state: 'ODISHA',
        country: 'INDIA',
      })
    ).id;
    const otherCustomerId = (
      await create('/customers', {
        name: `Other Payments Customer ${suffix}`,
        category: 'CORPORATE',
        state: 'ODISHA',
        country: 'INDIA',
      })
    ).id;
    const otherInvoice = await create('/invoices', {
      companyId: otherCompanyId,
      customerId: otherCustomerId,
      serviceCategoryId: categoryId,
      invoiceDate: '2026-10-07',
      guestDisplayText: 'Other Guest',
      serviceProvidedAt: 'ODISHA',
      placeOfSupplyState: 'ODISHA',
      placeOfSupplyCountry: 'INDIA',
      bankAccountIds: [],
      lines: [
        { description: 'Other', amount: '1.00', taxTreatment: 'NON_TAXABLE', taxComponents: [] },
      ],
    });
    expect(
      (await call('POST', `/invoices/${otherInvoice.id}/issue`, { version: otherInvoice.version }))
        .statusCode,
    ).toBe(200);
    otherReceiptId = randomUUID();
    await database.db.insert(receipts).values({
      id: otherReceiptId,
      invoiceId: otherInvoice.id,
      companyId: otherCompanyId,
      receiptNumber: `R/other/${suffix}`,
      financialYear: '2627',
      receivedDate: '2026-10-07',
      amount: '1.00',
      method: 'CASH',
      status: 'CONFIRMED',
      details: {},
      idempotencyKey: otherReceiptId,
      requestHash: 'test',
      createdBy: accounts[0]!.id,
    });
    // Historical records must survive inactive parties and cancelled invoice/booking states.
    await database.db
      .update(customers)
      .set({ status: 'INACTIVE' })
      .where(eq(customers.id, customerId));
    await database.db
      .update(companies)
      .set({ status: 'INACTIVE' })
      .where(eq(companies.id, companyId));
    await database.db
      .update(invoices)
      .set({ status: 'CANCELLED' })
      .where(eq(invoices.id, invoiceId));
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  it('includes every persisted state, historical records and precise full-result summaries by default', async () => {
    const r = await report();
    expect(r.data).toHaveLength(12);
    expect(r.summary).toMatchObject({
      total: 12,
      manualCount: 5,
      gatewayCount: 7,
      confirmedReceiptCount: 4,
      confirmedReceiptAmount: '140.30',
      pendingReceiptCount: 1,
      pendingReceiptAmount: '50.00',
      reversedReceiptCount: 2,
      reversedReceiptAmount: '50.00',
      providerConfirmedReviewAmount: '230.00',
    });
    expect(new Set(r.data.map((x) => x.gatewayStatus).filter(Boolean))).toEqual(
      new Set(['CREATING', 'READY', 'PAID', 'EXPIRED', 'TERMINATED', 'REVIEW_REQUIRED']),
    );
    expect(r.meta).toMatchObject({ from: null, to: null, dateBasis: 'PAYMENT_ACTIVITY_IST' });
    const all = (await call('GET', `/reports/payments?q=${suffix}&pageSize=100`)).json<Report>();
    expect(all.data.filter((x) => r.data.some((y) => y.id === x.id))).toHaveLength(12);
    expect(all.data.find((x) => x.receiptId === otherReceiptId)).toBeDefined();
    expect(all.summary.total).toBe(13);
    expect(all.summary.manualCount + all.summary.gatewayCount).toBe(13);
  });
  it('deduplicates linked receipts and distinguishes review, pending attempts and reversal from refund', async () => {
    const r = await report();
    const paid = r.data.find((x) => x.paymentOrderId === paidOrderId)!;
    expect(r.data.filter((x) => x.receiptId === paid.receiptId)).toHaveLength(1);
    expect(paid).toMatchObject({
      source: 'GATEWAY',
      gatewayStatus: 'PAID',
      receiptStatus: 'CONFIRMED',
    });
    const review = r.data.find((x) => x.paymentOrderId === reviewOrderId)!;
    expect(review).toMatchObject({
      receiptId: null,
      receiptStatus: null,
      gatewayStatus: 'REVIEW_REQUIRED',
      amount: '200.00',
      method: null,
    });
    expect(review.attempts[0]!.status).toBe('SUCCESS');
    expect(r.data.find((x) => x.paymentOrderId === reversedOrderId)).toMatchObject({
      gatewayStatus: 'PAID',
      receiptStatus: 'REVERSED',
      reversalReason: 'Accounting correction',
    });
    const pending = await report('gatewayStatus=READY');
    expect(pending.summary.confirmedReceiptAmount).toBe('0.00');
    expect(pending.summary.providerConfirmedReviewAmount).toBe('0.00');
    expect(pending.data[0]!.attempts[0]!.status).toBe('PENDING');
    expect(r.data.find((x) => x.source === 'MANUAL' && x.method === 'GATEWAY')).toBeDefined();
    const body = JSON.stringify(r);
    expect(body).not.toContain('SECRET');
    expect(body).not.toContain('accessToken');
  });
  it('summarizes the entire filtered result even on empty pages and sorts ties stably', async () => {
    const all = await report('sortBy=amount&sortOrder=asc');
    const page1 = await report('pageSize=2&sortBy=amount&sortOrder=asc');
    const page2 = await report('page=2&pageSize=2&sortBy=amount&sortOrder=asc');
    expect(page1.summary).toEqual(all.summary);
    expect([...page1.data, ...page2.data]).toEqual(all.data.slice(0, 4));
    const empty = await report('page=1000000');
    expect(empty.data).toEqual([]);
    expect(empty.pagination.total).toBe(12);
    expect(empty.summary.total).toBe(12);
    const ties = await report('sortBy=createdAt');
    expect((await report('sortBy=createdAt')).data.map((x) => x.id)).toEqual(
      ties.data.map((x) => x.id),
    );
    const filtered = await report('receiptStatus=CONFIRMED&source=GATEWAY');
    expect(filtered.summary).toMatchObject({
      total: 1,
      manualCount: 0,
      gatewayCount: 1,
      confirmedReceiptAmount: '100.00',
    });
  });
  it('recognizes an authoritative attempt receipt link when the order link is missing', async () => {
    const [order] = await database.db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, paidOrderId));
    await database.db
      .update(paymentOrders)
      .set({ receiptId: null })
      .where(eq(paymentOrders.id, paidOrderId));
    try {
      const r = await report();
      expect(r.summary.total).toBe(12);
      expect(r.summary.confirmedReceiptAmount).toBe('140.30');
      expect(r.data.filter((x) => x.receiptId === order!.receiptId)).toHaveLength(1);
      expect(r.data.find((x) => x.receiptId === order!.receiptId)?.source).toBe('GATEWAY');
    } finally {
      await database.db
        .update(paymentOrders)
        .set({ receiptId: order!.receiptId })
        .where(eq(paymentOrders.id, paidOrderId));
    }
  });
  it('keeps additional verified funds requiring review separate from an applied paid order', async () => {
    const [attempt] = await database.db
      .insert(paymentAttempts)
      .values({
        orderId: paidOrderId,
        provider: 'cashfree',
        providerPaymentId: `EXTRA-${suffix}`,
        status: 'SUCCESS',
        rawStatus: 'SUCCESS',
        amount: '5.25',
        currency: 'INR',
        initiatedAt: new Date('2026-10-07T09:00:00Z'),
        accountingStatus: 'REVIEW_REQUIRED',
      })
      .returning();
    try {
      const r = await report();
      expect(r.summary).toMatchObject({
        total: 12,
        confirmedReceiptAmount: '140.30',
        providerConfirmedReviewAmount: '235.25',
      });
      expect(r.data.find((x) => x.paymentOrderId === paidOrderId)).toMatchObject({
        gatewayStatus: 'PAID',
        receiptStatus: 'CONFIRMED',
        providerConfirmedReviewAmount: '5.25',
      });
    } finally {
      await database.db.delete(paymentAttempts).where(eq(paymentAttempts.id, attempt!.id));
    }
  });
  it('enforces the existing complete-result CSV limit before returning any export rows', async () => {
    const marker = `export-limit-${suffix}`;
    try {
      await database.db
        .execute(sql`insert into ${paymentOrders} (milestone_id, provider, provider_order_id, amount, status)
        select o.milestone_id, 'test', ${marker} || '-' || n, 1.00, 'READY'
        from ${paymentOrders} o cross join generate_series(1, 100001) n where o.id = ${paidOrderId}`);
      await database.db.execute(
        sql`analyze core.payment_orders, core.payment_attempts, core.payment_attempt_resolutions`,
      );
      const response = await call('GET', `/reports/payments/export?q=${marker}`);
      expect(response.statusCode, response.body).toBe(413);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'REPORT_EXPORT_TOO_LARGE',
      );
    } finally {
      await database.db.execute(
        sql`delete from ${paymentOrders} where provider = 'test' and provider_order_id like ${`${marker}-%`}`,
      );
    }
  }, 30000);
  it('uses inclusive India calendar boundaries and payment time ahead of receipt date', async () => {
    const r = await report('from=2026-10-07&to=2026-10-07');
    expect(r.data.find((x) => x.paymentOrderId === paidOrderId)?.reportDate).toBe('2026-10-07');
    expect(r.data.find((x) => x.paymentOrderId === reviewOrderId)?.reportDate).toBe('2026-10-07');
    expect(r.data.some((x) => x.gatewayStatus === 'READY')).toBe(false);
    expect(
      (await report('from=2026-10-08&to=2026-10-08')).data.some((x) => x.gatewayStatus === 'READY'),
    ).toBe(true);
    expect((await report('to=2020-01-01')).data.map((x) => x.gatewayStatus)).toEqual(['CREATING']);
  });
  it('applies intersecting source, status, method, identity and search filters', async () => {
    expect(
      (
        await report(
          `customerId=${customerId}&customerCategory=AGENT&serviceCategoryId=${categoryId}`,
        )
      ).summary.total,
    ).toBe(12);
    expect((await report('customerCategory=CORPORATE')).summary.total).toBe(0);
    expect((await report('source=MANUAL&gatewayStatus=PAID')).summary.total).toBe(0);
    expect(
      (await report('gatewayStatus=REVIEW_REQUIRED&receiptStatus=CONFIRMED')).summary.total,
    ).toBe(0);
    expect((await report('method=GATEWAY')).summary.total).toBe(3);
    expect((await report('method=CASH')).summary.confirmedReceiptAmount).toBe('0.30');
    for (const q of [`ORDER-${suffix}-5`, `PAYMENT-${suffix}-5`, `ATTEMPT-${suffix}-5`])
      expect((await report(`q=${q}`)).data[0]!.paymentOrderId).toBe(reviewOrderId);
    expect((await report(`q=PAYBOOK-${suffix}`)).summary.total).toBe(12);
    expect((await report(`q=Payments%20Customer%20${suffix}`)).summary.total).toBe(12);
    const [invoice] = await database.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect((await report(`q=${encodeURIComponent(invoice!.invoiceNumber!)}`)).summary.total).toBe(
      12,
    );
    const first = (await report('source=MANUAL')).data[0]!;
    expect((await report(`q=${encodeURIComponent(first.receiptNumber!)}`)).summary.total).toBe(1);
    expect((await report('q=%25')).summary.total).toBe(0); // literal wildcard
  });
  it('exports the complete identical filtered row set with references, states, empty headers and CSV escaping', async () => {
    const filter = `companyId=${companyId}&source=GATEWAY&sortBy=amount&sortOrder=asc`;
    const r = (await call('GET', `/reports/payments?${filter}`)).json<Report>();
    const response = await call('GET', `/reports/payments/export?${filter}&page=3&pageSize=1`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain('"receiptStatus"');
    expect(response.body).toContain('"gatewayStatus"');
    expect(response.body.split('\r\n')).toHaveLength(8);
    for (const row of r.data) expect(response.body).toContain(`"${row.id}"`);
    expect(response.body).not.toContain('SECRET');
    expect(
      (await call('GET', `/reports/payments/export?companyId=${companyId}&q=missing`)).body,
    ).toContain('"providerOrderId"');
    await database.db
      .update(commercialBookings)
      .set({ reference: '=SUM(1,2) "quote"' })
      .where(eq(commercialBookings.id, bookingId));
    try {
      expect((await call('GET', `/reports/payments/export?${filter}`)).body).toContain(
        '"\'=SUM(1,2) ""quote"""',
      );
    } finally {
      await database.db
        .update(commercialBookings)
        .set({ reference: `PAYBOOK-${suffix}` })
        .where(eq(commercialBookings.id, bookingId));
    }
  });
  it('includes all receipt states when legacy status is omitted, and supports GATEWAY method', async () => {
    const base = `/reports/payments-received?companyId=${companyId}&from=2026-10-01&to=2026-10-31`;
    const response = await call('GET', base);
    expect(response.statusCode, response.body).toBe(200);
    expect(
      new Set(response.json<{ data: { status: string }[] }>().data.map((x) => x.status)),
    ).toEqual(new Set(['PENDING', 'CONFIRMED', 'REVERSED']));
    expect(
      (await call('GET', `${base}&status=PENDING`)).json<{ data: unknown[] }>().data,
    ).toHaveLength(1);
    expect((await call('GET', `${base}&method=GATEWAY`)).statusCode).toBe(200);
  });
  it('validates filters and restricts both endpoints to existing staff report roles', async () => {
    for (const endpoint of ['/reports/payments', '/reports/payments/export']) {
      expect((await call('GET', endpoint, undefined, '')).statusCode).toBe(401);
      expect((await call('GET', endpoint, undefined, forbiddenCookie)).statusCode).toBe(403);
      for (const staffCookie of [viewerCookie, operatorCookie])
        expect(
          (await call('GET', `${endpoint}?companyId=${companyId}`, undefined, staffCookie))
            .statusCode,
        ).toBe(200);
      for (const query of [
        'gatewayStatus=PENDING',
        'receiptStatus=PAID',
        'source=OTHER',
        'method=BITCOIN',
        'sortBy=sessionId',
        'sortOrder=invalid',
        'page=0',
        'pageSize=101',
        'companyId=bad',
        'from=2026-02-30',
        'from=2026-10-08&to=2026-10-07',
      ])
        expect((await call('GET', `${endpoint}?${query}`)).statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});
