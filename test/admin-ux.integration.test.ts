import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import { authAccounts } from '../src/database/schema/accounts.js';
import { passwordHasher } from '../src/modules/auth/password.js';

import {
  commercialBookings,
  commercialQuotes,
  paymentAttempts,
  paymentMilestones,
  paymentOrders,
} from '../src/modules/core/persistence/commercial.schema.js';
import {
  invoices,
  receipts,
  settlementAdjustments,
} from '../src/modules/core/persistence/billing.schema.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
type Row = Record<string, unknown> & { id: string; version: number };
type Page = { data: Row[]; pagination: { page: number; pageSize: number; total: number } };
integration('admin UX additive list contracts', () => {
  let app: FastifyInstance, database: DatabaseClient;
  let admin: string, viewer: string, operator: string, feedback: string;
  let actorId: string, companyId: string, customerId: string, categoryId: string;
  let hotelId: string, invoiceId: string;
  let noneId: string, awaitingId: string, acceptedId: string;
  const reviewIds: string[] = [];
  const prefix = `ux${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const password = 'Admin-ux-test-password-123';
  const call = (
    path: string,
    cookie = admin,
    method: NonNullable<InjectOptions['method']> = 'GET',
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1/core${path}`,
      headers: { cookie },
      remoteAddress: randomUUID(),
      ...(payload === undefined
        ? {}
        : { payload: payload as NonNullable<InjectOptions['payload']> }),
    });
  async function create(path: string, payload: unknown) {
    const res = await call(path, admin, 'POST', payload);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ data: Row }>().data;
  }
  async function page(path: string) {
    const res = await call(path);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Page>();
  }
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DATABASE_SSL_MODE: 'disable',
    });
    database = createDatabaseClient(config);
    const hash = await passwordHasher.hash(password);
    const accounts = await database.db
      .insert(authAccounts)
      .values([
        {
          role: 'CORE_ADMIN',
          username: `${prefix}admin`,
          email: `${prefix}admin@example.com`,
          displayName: `${prefix} Admin`,
          passwordHash: hash,
        },
        {
          role: 'CORE_REPORT_VIEWER',
          username: `${prefix}viewer`,
          email: `${prefix}viewer@example.com`,
          displayName: 'UX Viewer',
          passwordHash: hash,
        },
        {
          role: 'CORE_DATA_ENTRY',
          username: `${prefix}entry`,
          email: `${prefix}entry@example.com`,
          displayName: 'UX Entry',
          passwordHash: hash,
        },
        {
          role: 'ADMIN',
          email: `${prefix}feedback@example.com`,
          displayName: 'UX Feedback',
          passwordHash: hash,
        },
      ])
      .returning();
    actorId = accounts[0]!.id;
    app = await buildApp({
      services: createApplicationServices(database.db, config),
      exposeDocs: false,
    });
    async function login(value: string, core = true) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/${core ? 'core' : 'admin'}/login`,
        payload: core ? { username: value, password } : { email: value, password },
      });
      expect(res.statusCode, res.body).toBe(200);
      return String(res.headers['set-cookie']).split(';')[0]!;
    }
    admin = await login(`${prefix}admin`);
    viewer = await login(`${prefix}viewer`);
    operator = await login(`${prefix}entry`);
    feedback = await login(`${prefix}feedback@example.com`, false);
    companyId = (
      await create('/companies', {
        name: `${prefix} Parent`,
        address: 'Address',
        state: 'ODISHA',
        country: 'INDIA',
      })
    ).id;
    customerId = (
      await create('/customers', {
        name: `${prefix} Customer`,
        category: 'LEISURE',
        state: 'ODISHA',
        country: 'INDIA',
      })
    ).id;
    categoryId = (await create('/service-categories', { name: `${prefix} Parent`, code: 'UX' })).id;
    hotelId = (await create('/hotels', { name: `${prefix} Parent` })).id;
    await create('/vendors', { name: `${prefix} Parent` });
    // Bulk directories: target sorts after the first 100. No invitations or provider operations.
    for (const table of [
      'companies',
      'guests',
      'hotels',
      'hotel_rates',
      'bank_accounts',
      'service_categories',
      'tax_rules',
    ]) {
      let extra = sql``;
      let values = sql``;
      if (table === 'hotel_rates') {
        extra = sql`, hotel_id, plan, amount`;
        values = sql`, ${hotelId}::uuid, 'APAI', 10`;
      }
      if (table === 'bank_accounts') {
        extra = sql`, company_id, account_number`;
        values = sql`, ${companyId}::uuid, 'test-account'`;
      }
      if (table === 'service_categories') {
        extra = sql`, code`;
        values = sql`, ${prefix} || n`;
      }
      if (table === 'tax_rules') {
        extra = sql`, component, rate, effective_from, service_category_id`;
        values = sql`, 'IGST', 0, '2026-01-01'::date, ${categoryId}::uuid`;
      }
      await database.db
        .execute(sql`insert into core.${sql.identifier(table)} (name, status ${extra})
        select ${prefix} || ' Directory ' || lpad(n::text, 3, '0') || case when n >= 104 then ' Needle' else '' end,
          case when n = 105 then 'INACTIVE' else 'ACTIVE' end::core.master_status ${values}
        from generate_series(0, 105) n`);
    }
    await database.db.execute(sql`insert into vendors (name, contact_name, status)
      select ${prefix} || ' Directory ' || lpad(n::text, 3, '0'), case when n >= 104 then ${prefix} || ' Needle' end,
        case when n=105 then 'DEACTIVATED' else 'ACTIVE' end::lifecycle_status from generate_series(0,105) n`);
    await database.db
      .execute(sql`insert into vehicles (registration_number, display_name, vehicle_type, registered_owner, status)
      select ${prefix} || lpad(n::text,3,'0'), ${prefix} || ' Directory', 'CAR',
        case when n>=104 then ${prefix} || ' Needle' end,
        case when n=105 then 'DEACTIVATED' else 'ACTIVE' end::lifecycle_status from generate_series(0,105) n`);
    await database.db
      .execute(sql`insert into core.vendor_profiles (vendor_id, city, mobile_number, status)
      select id, ${prefix} || ' Directory', case when contact_name is not null then ${prefix} || ' Needle' end,
        case when status='DEACTIVATED' then 'INACTIVE' else 'ACTIVE' end::core.master_status from vendors where name like ${prefix + ' Directory%'}`);
    await database.db
      .execute(sql`insert into auth_accounts (username, email, display_name, password_hash, role, status)
      select ${prefix} || n, ${prefix} || n || '@example.com', ${prefix} || ' Directory ' || lpad(n::text,3,'0') || case when n>=104 then ' Needle' else '' end,
        ${hash}, 'CORE_DATA_ENTRY', case when n=105 then 'DEACTIVATED' else 'ACTIVE' end::lifecycle_status from generate_series(0,105) n`);
    const invoice = await create('/invoices', {
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      invoiceDate: '2026-10-08',
      dueDate: '2026-10-09',
      guestDisplayText: 'UX Guest',
      serviceProvidedAt: 'ODISHA',
      placeOfSupplyState: 'ODISHA',
      placeOfSupplyCountry: 'INDIA',
      bankAccountIds: [],
      lines: [
        { description: 'UX', amount: '1000.00', taxTreatment: 'NON_TAXABLE', taxComponents: [] },
      ],
    });
    invoiceId = invoice.id;
    const issued = await call(`/invoices/${invoiceId}/issue`, admin, 'POST', {
      version: invoice.version,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const bookings = await database.db
      .insert(commercialBookings)
      .values(
        Array.from({ length: 106 }, (_, n) => ({
          reference: `${prefix}-${n}`,
          title: `${prefix} Booking ${n}`,
          companyId,
          customerId,
          serviceCategoryId: categoryId,
          createdBy: actorId,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)),
          serviceStartsOn: n < 103 ? '2026-10-01' : '2026-10-08',
          status: n === 105 ? 'CONFIRMED' : 'DRAFT',
          invoiceId: n === 105 ? invoiceId : null,
          accessTokenHash: `SECRET-BOOKING-HASH-${prefix}-${n}`,
        })),
      )
      .returning();
    noneId = bookings[103]!.id;
    awaitingId = bookings[104]!.id;
    acceptedId = bookings[105]!.id;
    for (const [bookingId, accepted] of [
      [awaitingId, false],
      [acceptedId, true],
    ] as const) {
      await database.db.insert(commercialQuotes).values(
        [1, 2].map((version) => ({
          bookingId,
          version,
          description: 'Legacy quote',
          inclusions: '',
          exclusions: '',
          terms: '',
          total: '1000.00',
          // An old accepted quote must not make a new unaccepted quote accepted.
          acceptedAt: version === 1 || accepted ? new Date('2026-10-08T00:00:00Z') : null,
        })),
      );
    }
    const receipt = async (amount: string, status: 'CONFIRMED' | 'PENDING' | 'REVERSED') => {
      const [row] = await database.db
        .insert(receipts)
        .values({
          invoiceId,
          companyId,
          receiptNumber: randomUUID(),
          financialYear: '2627',
          receivedDate: '2026-10-08',
          amount,
          status,
          method: 'CASH',
          details: {},
          idempotencyKey: randomUUID(),
          requestHash: 'test',
          createdBy: actorId,
          reversalReason: status === 'REVERSED' ? 'test reversal' : null,
        })
        .returning();
      return row!.id;
    };
    await receipt('100.10', 'CONFIRMED');
    await receipt('20.20', 'CONFIRMED');
    await receipt('50.00', 'PENDING');
    const reversedReceiptId = await receipt('30.00', 'REVERSED');
    await database.db.insert(settlementAdjustments).values({
      invoiceId,
      amount: '10.00',
      reason: 'UX adjustment',
      createdBy: actorId,
      date: '2026-10-08',
      idempotencyKey: randomUUID(),
      requestHash: 'test',
    });
    const [milestone] = await database.db
      .insert(paymentMilestones)
      .values({
        bookingId: acceptedId,
        position: 1,
        label: 'UX',
        amount: '1000.00',
        dueOn: '2026-10-08',
      })
      .returning();
    for (const kind of [
      'review',
      'paid-review',
      'legacy-reversed',
      'marked-pending',
      'clean',
      'refunded',
    ]) {
      const [order] = await database.db
        .insert(paymentOrders)
        .values({
          milestoneId: milestone!.id,
          provider: 'test',
          providerOrderId: `${prefix}-${kind}`,
          amount: '10.00',
          status: kind === 'review' ? 'REVIEW_REQUIRED' : kind === 'refunded' ? 'REFUNDED' : 'PAID',
          reviewRequiredAt: kind === 'marked-pending' ? new Date() : null,
          providerPaymentId: `${prefix}-${kind}`,
          receiptId: kind === 'legacy-reversed' ? reversedReceiptId : null,
        })
        .returning();
      if (!['clean', 'refunded'].includes(kind)) reviewIds.push(order!.id);
      if (kind === 'paid-review')
        await database.db.insert(paymentAttempts).values({
          orderId: order!.id,
          provider: 'test',
          providerPaymentId: `${prefix}-second-review`,
          status: 'SUCCESS',
          rawStatus: 'test',
          amount: '10.00',
          currency: 'INR',
          initiatedAt: new Date(),
          accountingStatus: 'REVIEW_REQUIRED',
        });
      await database.db.insert(paymentAttempts).values({
        orderId: order!.id,
        provider: 'test',
        providerPaymentId: `${prefix}-${kind}`,
        status: kind === 'marked-pending' ? 'PENDING' : 'SUCCESS',
        rawStatus: 'test',
        amount: '10.00',
        currency: 'INR',
        initiatedAt: new Date(),
        accountingStatus: ['review', 'paid-review'].includes(kind)
          ? 'REVIEW_REQUIRED'
          : kind === 'refunded'
            ? 'REFUNDED'
            : kind === 'legacy-reversed'
              ? 'APPLIED'
              : 'UNAPPLIED',
      });
    }
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  it.each([
    'guests',
    'hotels',
    'hotel-rates',
    'vendors',
    'vendor-profiles',
    'vehicles',
    'companies',
    'bank-accounts',
    'service-categories',
    'tax-rules',
    'users',
  ])(
    '%s searches beyond 100 before pagination and counts combined status filters',
    async (path) => {
      const term = encodeURIComponent(
        `  ${prefix.toUpperCase()} ${['vendors', 'vehicles', 'vendor-profiles'].includes(path) ? 'NEEDLE' : 'DIRECTORY 104 NEEDLE'}  `,
      );
      const found = await page(`/${path}?q=${term}&status=ACTIVE&pageSize=1`);
      expect(found.data).toHaveLength(1);
      expect(found.pagination.total).toBe(1);
      const all = await page(
        `/${path}?q=${prefix}%20${['vendors', 'vehicles', 'vendor-profiles'].includes(path) ? 'Needle' : 'Directory'}&pageSize=1&page=999`,
      );
      expect(all.data).toEqual([]);
      expect(all.pagination.total).toBe(
        ['vendors', 'vehicles', 'vendor-profiles'].includes(path) ? 2 : 106,
      );
      const blank = await page(`/${path}?q=%20%20&pageSize=1`);
      const noQuery = await page(`/${path}?pageSize=1`);
      expect(blank).toEqual(noQuery);
      expect((await page(`/${path}?q=${prefix}%25`)).pagination.total).toBe(0);
    },
  );
  it('combines UUID relationship, status and search filters', async () => {
    for (const [path, key, id] of [
      ['bank-accounts', 'companyId', companyId],
      ['hotel-rates', 'hotelId', hotelId],
    ] as const) {
      expect(
        (await page(`/${path}?${key}=${id}&q=${prefix}%20Directory&status=ACTIVE&pageSize=1`))
          .pagination.total,
      ).toBe(105);
      expect((await page(`/${path}?${key}=${randomUUID()}&q=${prefix}`)).pagination.total).toBe(0);
      expect((await call(`/${path}?${key}=invalid`)).statusCode).toBe(400);
    }
    const vendor = (await page(`/vendors?q=${prefix}%20Needle&status=ACTIVE`)).data[0]!;
    const result = await page(
      `/vendor-profiles?vendorId=${vendor.id}&q=${prefix}%20Needle&status=ACTIVE`,
    );
    expect(result.pagination.total).toBe(1);
    expect((await call('/vendor-profiles?vendorId=invalid')).statusCode).toBe(400);
  });
  it('filters bookings by latest legacy quote, dates, parties and status; keeps an array and full totals', async () => {
    const base = `/commercial-bookings?companyId=${companyId}&customerId=${customerId}&q=${prefix.toUpperCase()}%20CUSTOMER&serviceStartsFrom=2026-10-08&serviceStartsTo=2026-10-08`;
    const rows = await page(`${base}&pageSize=1`);
    expect(rows.pagination.total).toBe(3);
    expect(rows.data).toHaveLength(1);
    const accepted = await page(`${base}&quoteAcceptance=ACCEPTED&status=CONFIRMED`);
    expect(accepted.data.map((r) => r.id)).toEqual([acceptedId]);
    expect(accepted.data[0]).toMatchObject({
      customerName: `${prefix} Customer`,
      latestQuoteVersion: 2,
      receivedAmount: '120.30',
      dueAmount: '869.70',
    });
    expect(accepted.data[0]!.latestQuoteAcceptedAt).toBeTruthy();
    expect(accepted.data[0]!.invoiceNumber).toBeTruthy();
    const awaiting = await page(`${base}&quoteAcceptance=AWAITING_ACCEPTANCE`);
    expect(awaiting.data.map((r) => r.id)).toEqual([awaitingId]);
    expect(awaiting.data[0]).toMatchObject({
      latestQuoteVersion: 2,
      latestQuoteAcceptedAt: null,
      invoiceNumber: null,
      receivedAmount: null,
      dueAmount: null,
    });
    expect((await page(`${base}&quoteAcceptance=NONE`)).data.map((r) => r.id)).toEqual([noneId]);
    expect((await page(`${base}&page=99`)).pagination.total).toBe(3);
    expect((await page(`/commercial-bookings?q=${prefix}&pageSize=100`)).pagination.total).toBe(
      106,
    );
    expect(JSON.stringify(rows)).not.toContain('SECRET-BOOKING-HASH');
    const oldest = await page(`/commercial-bookings?q=${prefix}-0`);
    expect(oldest.pagination.total).toBe(1);
    expect(oldest.data[0]!.reference).toBe(`${prefix}-0`);
    expect(
      (await page(`/commercial-bookings?q=%20%20&companyId=${companyId}`)).pagination.total,
    ).toBe(106);
    const report = await page(
      `/reports/invoices?companyId=${companyId}&from=2026-10-01&to=2026-10-31`,
    );
    expect(accepted.data[0]!.receivedAmount).toBe(report.data[0]!.receivedAmount);
    expect(accepted.data[0]!.dueAmount).toBe(report.data[0]!.dueAmount);
  });
  it.each([
    'companyId=bad',
    'customerId=bad',
    'status=INVALID',
    'quoteAcceptance=INVALID',
    'serviceStartsFrom=2026-02-30',
    'serviceStartsFrom=2026-10-09&serviceStartsTo=2026-10-08',
    'pageSize=101',
  ])('rejects invalid booking filters %s', async (query) => {
    expect((await call(`/commercial-bookings?${query}`)).statusCode).toBe(
      query.includes('serviceStartsTo') ? 422 : 400,
    );
  });
  it('uses the review API predicate for paid cases, legacy reversed receipts, markers, totals and export', async () => {
    const result = await page(
      `/reports/payments?companyId=${companyId}&needsReview=true&pageSize=1`,
    );
    expect(result.pagination.total).toBe(4);
    expect(result.data).toHaveLength(1);
    const full = await page(`/reports/payments?companyId=${companyId}&needsReview=true`);
    expect(full.data.map((r) => r.paymentOrderId).sort()).toEqual([...reviewIds].sort());
    expect(full.data.every((r) => r.needsReview === true)).toBe(true);
    expect(
      (await page(`/reports/payments?companyId=${companyId}&needsReview=true&gatewayStatus=PAID`))
        .pagination.total,
    ).toBe(3);
    expect(
      (await page(`/reports/payments?companyId=${companyId}&needsReview=true&source=MANUAL`))
        .pagination.total,
    ).toBe(0);
    for (const id of reviewIds) {
      const inspection = await call(`/payment-orders/${id}/review`);
      expect(inspection.statusCode, inspection.body).toBe(200);
      expect(inspection.json<{ data: { needsReview: boolean } }>().data.needsReview).toBe(true);
    }
    const csv = await call(
      `/reports/payments/export?companyId=${companyId}&needsReview=true&pageSize=1`,
    );
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body.split('\n')).toHaveLength(5);
    const dashboard = await call('/reports/dashboard');
    const scoped = await call(
      `/reports/dashboard?companyId=${randomUUID()}&from=2000-01-01&to=2000-01-02`,
    );
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const count = (r: typeof dashboard) =>
      r.json<{ data: { alerts: { paymentsRequiringReview: number } } }>().data.alerts
        .paymentsRequiringReview;
    expect(count(dashboard)).toBeGreaterThanOrEqual(4);
    expect(count(scoped)).toBe(count(dashboard));
    expect((await call('/reports/payments?needsReview=invalid')).statusCode).toBe(400);
    const [unchanged] = await database.db
      .select()
      .from(invoices)
      .where(sql`${invoices.id} = ${invoiceId}`);
    expect(unchanged!.grandTotal).toBe('1000.00');
  }, 30000);
  it('preserves read boundaries and keeps staff restricted to admins', async () => {
    for (const cookie of [viewer, operator]) {
      expect((await call(`/guests?q=${prefix}`, cookie)).statusCode).toBe(200);
      expect((await call(`/commercial-bookings?q=${prefix}`, cookie)).statusCode).toBe(200);
      expect((await call(`/users?q=${prefix}`, cookie)).statusCode).toBe(403);
    }
    expect((await call(`/guests?q=${prefix}`, feedback)).statusCode).toBe(403);
    expect((await call('/commercial-bookings', feedback)).statusCode).toBe(403);
    expect((await call('/reports/payments?needsReview=true', feedback)).statusCode).toBe(403);
    expect((await call('/guests', '')).statusCode).toBe(401);
    const users = await page(`/users?q=${prefix}`);
    expect(JSON.stringify(users)).not.toContain('passwordHash');
    expect(users.data.every((r) => String(r.role).startsWith('CORE_'))).toBe(true);
  });
  it('rejects bank accounts owned by another company on invoice writes', async () => {
    const other = await create('/companies', { name: `${prefix} Other` });
    const bank = await create('/bank-accounts', {
      companyId: other.id,
      name: 'Other bank',
      accountNumber: 'test',
    });
    const res = await call('/invoices', admin, 'POST', {
      companyId,
      customerId,
      serviceCategoryId: categoryId,
      invoiceDate: '2026-10-08',
      guestDisplayText: 'UX Guest',
      serviceProvidedAt: 'ODISHA',
      placeOfSupplyState: 'ODISHA',
      placeOfSupplyCountry: 'INDIA',
      bankAccountIds: [bank.id],
      lines: [
        { description: 'UX', amount: '1.00', taxTreatment: 'NON_TAXABLE', taxComponents: [] },
      ],
    });
    expect(res.statusCode, res.body).toBe(422);
  });
});
