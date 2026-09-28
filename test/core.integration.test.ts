import { importLegacyInvoice } from '../src/modules/core/legacy/invoice-import.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import { authAccounts } from '../src/database/schema/accounts.js';
import { passwordHasher } from '../src/modules/auth/password.js';
interface TestRecord {
  id: string;
  version: number;
  invoiceNumber: string;
  snapshot: {
    customer: { name: string; category: string };
    guest: { name: string } | null;
    bankAccounts: { accountNumber: string }[];
  };
  lines: Array<{
    taxes: unknown[];
    appliedTaxes: Array<{
      component: string;
      rate: string;
      amount: string;
      ruleId: string | null;
    }>;
    taxAmount: string;
    total: string;
  }>;
  [key: string]: unknown;
}
interface TestEnvelope {
  data: TestRecord;
  error: { code: string };
}
const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration('core modular API', () => {
  let app: FastifyInstance, database: DatabaseClient;
  let adminCookie: string, viewerCookie: string, operatorCookie: string, feedbackCookie: string;
  let companyId: string,
    customerId: string,
    guestId: string,
    categoryId: string,
    carCategoryId: string,
    vehicleId: string,
    bankId: string,
    rateId: string;
  const suffix = randomUUID().slice(0, 8),
    password = 'Core-integration-password-123';
  const username = `core-${suffix}`;
  const call = (
    method: NonNullable<InjectOptions['method']>,
    url: string,
    payload?: unknown,
    cookie = adminCookie,
    key?: string,
  ) =>
    app.inject({
      method,
      url: `/api/v1/core${url}`,
      headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
      ...(payload === undefined
        ? {}
        : { payload: payload as NonNullable<InjectOptions['payload']> }),
    });
  async function create(path: string, payload: unknown) {
    const response = await call('POST', path, payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<TestEnvelope>().data;
  }
  function draft(amount = '81500.00') {
    return {
      companyId,
      customerId,
      guestId,
      serviceCategoryId: categoryId,
      invoiceDate: '2026-08-20',
      dueDate: '2026-08-30',
      guestDisplayText: 'Traveller X 04',
      passengerCount: 4,
      serviceProvidedAt: 'ODISHA',
      placeOfSupplyState: 'ODISHA',
      placeOfSupplyCountry: 'INDIA',
      label: 'August itinerary',
      bankAccountIds: [bankId],
      lines: [
        {
          description: '4 PAX / itinerary / 17 TO 21 AUGUST / hotel / vehicle',
          amount,
          taxTreatment: 'TAXABLE',
          taxComponents: ['IGST'],
        },
      ],
    };
  }
  async function issued(amount = '100.00') {
    const record = await create('/invoices', draft(amount));
    const response = await call('POST', `/invoices/${record.id}/issue`, {
      version: record.version,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<TestEnvelope>().data;
  }
  beforeAll(async () => {
    database = createDatabaseClient(
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, DATABASE_SSL_MODE: 'disable' }),
    );
    const passwordHash = await passwordHasher.hash(password);
    await database.db.insert(authAccounts).values([
      {
        role: 'CORE_ADMIN',
        username,
        email: `${username}@example.com`,
        displayName: 'Core Admin',
        passwordHash,
      },
      {
        role: 'CORE_REPORT_VIEWER',
        username: `viewer-${suffix}`,
        email: `viewer-${suffix}@example.com`,
        displayName: 'Viewer',
        passwordHash,
      },
      {
        role: 'CORE_DATA_ENTRY',
        username: `operator-${suffix}`,
        email: `operator-${suffix}@example.com`,
        displayName: 'Operator',
        passwordHash,
      },
      {
        role: 'ADMIN',
        email: `feedback-${suffix}@example.com`,
        displayName: 'Feedback Admin',
        passwordHash,
      },
    ]);
    app = await buildApp({
      services: createApplicationServices(
        database.db,
        loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, DATABASE_SSL_MODE: 'disable' }),
      ),
      exposeDocs: false,
    });
    async function login(user: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/core/login',
        payload: { username: user, password },
      });
      expect(response.statusCode, response.body).toBe(200);
      return String(response.headers['set-cookie']).split(';')[0]!;
    }
    adminCookie = await login(username);
    viewerCookie = await login(`viewer-${suffix}`);
    operatorCookie = await login(`operator-${suffix}`);
    const feedback = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: `feedback-${suffix}@example.com`, password },
    });
    expect(feedback.statusCode).toBe(200);
    feedbackCookie = String(feedback.headers['set-cookie']).split(';')[0]!;
    companyId = (
      await create('/companies', {
        name: `Eastern Risen ${suffix}`,
        address: 'Company address',
        state: 'ODISHA',
        country: 'INDIA',
        gstNumber: 'TEST-GST',
      })
    ).id;
    customerId = (
      await create('/customers', {
        name: 'Agent Customer',
        category: 'AGENT',
        address: 'Billing address',
        state: 'GUJARAT',
        country: 'INDIA',
      })
    ).id;
    guestId = (
      await create('/guests', {
        name: 'Traveller X',
        market: 'DOMESTIC',
      })
    ).id;
    bankId = (
      await create('/bank-accounts', {
        companyId,
        name: 'Bank',
        bankName: 'Example Bank',
        accountNumber: '00001234',
        ifscCode: 'TEST0000123',
      })
    ).id;
    categoryId = (await create('/service-categories', { name: 'Itinerary', code: '9985' })).id;
    carCategoryId = (
      await create('/service-categories', {
        name: `Car Service ${suffix}`,
        code: '9966',
        requiresVehicle: true,
      })
    ).id;
    vehicleId = (
      await create('/vehicles', {
        registrationNumber: `INV${suffix}`,
        displayName: 'Invoice Vehicle',
        vehicleType: 'SEDAN',
      })
    ).id;
    rateId = (
      await create('/tax-rules', {
        name: 'IGST 5%',
        component: 'IGST',
        serviceCategoryId: categoryId,
        rate: '5',
        effectiveFrom: '2026-01-01',
      })
    ).id;
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });
  it('isolates core permissions from feedback administrator access', async () => {
    expect((await call('GET', '/companies', undefined, feedbackCookie)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/admin/vehicles',
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect((await call('GET', '/companies', undefined, viewerCookie)).statusCode).toBe(200);
    expect((await call('POST', '/invoices', draft(), viewerCookie)).statusCode).toBe(403);
    expect(
      (
        await call(
          'POST',
          '/companies',
          { name: 'Denied', address: 'Address', state: 'State', country: 'Country' },
          operatorCookie,
        )
      ).statusCode,
    ).toBe(403);
    expect((await call('POST', '/invoices', draft(), operatorCookie)).statusCode).toBe(201);
  });
  it('lets core users read and update their own profile', async () => {
    const profile = await call('GET', '/profile');
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json<TestEnvelope>().data).toMatchObject({
      username,
      displayName: 'Core Admin',
      role: 'CORE_ADMIN',
    });

    const update = await call('PATCH', '/profile', { displayName: 'Core Admin Updated' });
    expect(update.statusCode, update.body).toBe(200);
    expect(update.json<TestEnvelope>().data).toMatchObject({
      username,
      displayName: 'Core Admin Updated',
      role: 'CORE_ADMIN',
    });

    expect((await call('GET', '/profile', undefined, viewerCookie)).statusCode).toBe(200);
    expect((await call('GET', '/profile', undefined, feedbackCookie)).statusCode).toBe(403);
  });
  it('returns every draft field, human-readable snapshots and auditable applied taxes', async () => {
    const created = await create('/invoices', draft('10000.00'));
    expect(created).toMatchObject({
      companyId,
      customerId,
      guestId,
      guestDisplayText: 'Traveller X 04',
      passengerCount: 4,
      serviceCategoryId: categoryId,
      invoiceDate: '2026-08-20',
      dueDate: '2026-08-30',
      serviceProvidedAt: 'ODISHA',
      placeOfSupplyState: 'ODISHA',
      placeOfSupplyCountry: 'INDIA',
      label: 'August itinerary',
      bankAccountIds: [bankId],
      subtotal: '10000.00',
      taxTotal: '500.00',
      grandTotal: '10500.00',
      snapshot: {
        company: { id: companyId, name: `Eastern Risen ${suffix}` },
        customer: { id: customerId, name: 'Agent Customer' },
        guest: { id: guestId, name: 'Traveller X' },
        serviceCategory: { id: categoryId, name: 'Itinerary', code: '9985' },
        bankAccounts: [
          {
            id: bankId,
            name: 'Bank',
            bankName: 'Example Bank',
            accountNumber: '00001234',
            ifscCode: 'TEST0000123',
          },
        ],
      },
      lines: [
        {
          position: 1,
          description: '4 PAX / itinerary / 17 TO 21 AUGUST / hotel / vehicle',
          amount: '10000.00',
          taxTreatment: 'TAXABLE',
          taxAmount: '500.00',
          total: '10500.00',
          appliedTaxes: [{ component: 'IGST', rate: '5.00', amount: '500.00', ruleId: rateId }],
        },
      ],
    });
    expect(created.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ appliedTaxes: created.lines[0]!.taxes })]),
    );

    const updatedResponse = await call('PUT', `/invoices/${created.id}`, {
      ...draft('200.00'),
      guestDisplayText: 'Updated traveller group',
      passengerCount: 5,
      dueDate: null,
      label: null,
      version: created.version,
    });
    expect(updatedResponse.statusCode, updatedResponse.body).toBe(200);
    const updated = updatedResponse.json<TestEnvelope>().data;
    expect(updated).toMatchObject({
      version: 2,
      guestDisplayText: 'Updated traveller group',
      passengerCount: 5,
      dueDate: null,
      label: null,
      subtotal: '200.00',
      taxTotal: '10.00',
      grandTotal: '210.00',
    });
    const stored = (await call('GET', `/invoices/${created.id}`)).json<TestEnvelope>().data;
    expect(stored).toMatchObject(updated);
    expect(
      (await call('PUT', `/invoices/${created.id}`, { ...draft(), version: 1 })).statusCode,
    ).toBe(409);
  });
  it('requires and snapshots a vehicle only for configured car-service categories', async () => {
    const missingVehicle = await call('POST', '/invoices', {
      ...draft('100.00'),
      serviceCategoryId: carCategoryId,
      lines: [{ ...draft('100.00').lines[0], taxTreatment: 'NON_TAXABLE', taxComponents: [] }],
    });
    expect(missingVehicle.statusCode, missingVehicle.body).toBe(422);

    const carInvoice = await create('/invoices', {
      ...draft('100.00'),
      serviceCategoryId: carCategoryId,
      vehicleId,
      lines: [{ ...draft('100.00').lines[0], taxTreatment: 'NON_TAXABLE', taxComponents: [] }],
    });
    expect(carInvoice).toMatchObject({
      vehicleId,
      details: { vehicleId },
      snapshot: {
        serviceCategory: { id: carCategoryId, requiresVehicle: true },
        vehicle: {
          id: vehicleId,
          name: 'Invoice Vehicle',
          registrationNumber: `INV${suffix}`.toUpperCase(),
          vehicleType: 'SEDAN',
        },
      },
    });

    const unexpectedVehicle = await call('POST', '/invoices', { ...draft('100.00'), vehicleId });
    expect(unexpectedVehicle.statusCode, unexpectedVehicle.body).toBe(422);
  });
  it('returns separate CGST/SGST entries and empty breakdowns for untaxed treatments', async () => {
    const cgstId = (
      await create('/tax-rules', {
        name: `CGST 2.5% ${suffix}`,
        component: 'CGST',
        serviceCategoryId: categoryId,
        rate: '2.5',
        effectiveFrom: '2026-01-01',
      })
    ).id;
    const sgstId = (
      await create('/tax-rules', {
        name: `SGST 2.5% ${suffix}`,
        component: 'SGST',
        serviceCategoryId: categoryId,
        rate: '2.5',
        effectiveFrom: '2026-01-01',
      })
    ).id;
    const invoice = await create('/invoices', {
      ...draft(),
      lines: [
        {
          description: 'Intrastate service',
          amount: '100.00',
          taxTreatment: 'TAXABLE',
          taxComponents: ['CGST', 'SGST'],
        },
        ...(['NON_TAXABLE', 'EXEMPT', 'NIL_RATED'] as const).map((taxTreatment) => ({
          description: taxTreatment,
          amount: '10.00',
          taxTreatment,
          taxComponents: [],
        })),
      ],
    });
    expect(invoice).toMatchObject({ subtotal: '130.00', taxTotal: '5.00', grandTotal: '135.00' });
    expect(invoice.lines[0]!.appliedTaxes).toEqual([
      expect.objectContaining({ component: 'CGST', rate: '2.50', amount: '2.50', ruleId: cgstId }),
      expect.objectContaining({ component: 'SGST', rate: '2.50', amount: '2.50', ruleId: sgstId }),
    ]);
    for (const line of invoice.lines.slice(1)) {
      expect(line.taxAmount).toBe('0.00');
      expect(line.total).toBe('10.00');
      expect(line.appliedTaxes).toEqual([]);
    }
  });
  it('preserves the source invoice totals and issued snapshots', async () => {
    const invoice = await issued('81500.00');
    expect(invoice).toMatchObject({
      subtotal: '81500.00',
      taxTotal: '4075.00',
      grandTotal: '85575.00',
      status: 'ISSUED',
    });
    expect(invoice.invoiceNumber).toMatch(/^I\/2627\/\d{6}$/);
    expect(invoice.snapshot.customer.category).toBe('AGENT');
    expect(invoice.snapshot.guest!.name).toBe('Traveller X');
    expect(invoice.snapshot.bankAccounts[0]!.accountNumber).toBe('00001234');
    const update = await call('PUT', `/customers/${customerId}`, {
      name: 'Renamed Agent',
      category: 'AGENT',
      version: 1,
    });
    expect(update.statusCode, update.body).toBe(200);
    const stored = await call('GET', `/invoices/${invoice.id}`);
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json<TestEnvelope>().data.snapshot.customer.name).toBe('Agent Customer');
    expect(stored.json<TestEnvelope>().data.dueAmount).toBe('85575.00');
    expect(
      (await call('PUT', `/invoices/${invoice.id}`, { ...draft(), version: invoice.version }))
        .statusCode,
    ).toBe(409);
  });
  it('detects stale master updates and translates missing references', async () => {
    const stale = await call('PUT', `/customers/${customerId}`, {
      name: 'Stale',
      category: 'AGENT',
      version: 1,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const missing = await call('POST', '/bank-accounts', {
      companyId: randomUUID(),
      name: 'Invalid',
      accountNumber: '0001',
    });
    expect(missing.statusCode, missing.body).toBe(422);
  });
  it('allocates invoice numbers once for retries and uniquely under concurrency', async () => {
    const invoice = await create('/invoices', draft());
    const responses = await Promise.all(
      [1, 2].map(() => call('POST', `/invoices/${invoice.id}/issue`, { version: 1 })),
    );
    responses.forEach((response) => expect(response.statusCode, response.body).toBe(200));
    expect(responses[0]!.json<TestEnvelope>().data.invoiceNumber).toBe(
      responses[1]!.json<TestEnvelope>().data.invoiceNumber,
    );
    const other = await Promise.all([issued(), issued()]);
    expect(other[0].invoiceNumber).not.toBe(other[1].invoiceNumber);
  });
  it('prevents concurrent overpayment and replays receipts idempotently', async () => {
    const invoice = await issued();
    const body = {
      invoiceId: invoice.id,
      receivedDate: '2026-08-21',
      amount: '80.00',
      method: 'CASH',
      details: {},
      status: 'CONFIRMED',
    };
    const responses = await Promise.all(
      ['one', 'two'].map((key) =>
        call('POST', '/receipts', body, adminCookie, `${suffix}-receipt-${key}`),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const index = responses.findIndex((r) => r.statusCode === 201),
      key = `${suffix}-receipt-${index === 0 ? 'one' : 'two'}`;
    const replay = await call('POST', '/receipts', body, adminCookie, key);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json<TestEnvelope>().data.id).toBe(
      responses[index]!.json<TestEnvelope>().data.id,
    );
    expect(replay.json<TestEnvelope>().data.requestHash).toBeUndefined();
    const conflict = await call(
      'POST',
      '/receipts',
      { ...body, amount: '20.00' },
      adminCookie,
      key,
    );
    expect(conflict.statusCode).toBe(409);
    expect((await call('GET', `/invoices/${invoice.id}`)).json<TestEnvelope>().data.dueAmount).toBe(
      '25.00',
    );
  });
  it('handles pending receipts, discounts and reversals without changing invoice tax', async () => {
    const invoice = await issued();
    const receipt = await call(
      'POST',
      '/receipts',
      {
        invoiceId: invoice.id,
        receivedDate: '2026-08-21',
        amount: '100.00',
        method: 'CHEQUE',
        details: { reference: '123', bankName: 'Bank', instrumentDate: '2026-08-21' },
        status: 'PENDING',
      },
      adminCookie,
      `${suffix}-pending-receipt`,
    );
    expect(receipt.statusCode, receipt.body).toBe(201);
    expect((await call('GET', `/invoices/${invoice.id}`)).json<TestEnvelope>().data.dueAmount).toBe(
      '105.00',
    );
    const confirmed = await call(
      'POST',
      `/receipts/${receipt.json<TestEnvelope>().data.id}/confirm`,
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const adjustment = await call(
      'POST',
      '/settlement-adjustments',
      {
        invoiceId: invoice.id,
        amount: '5.00',
        reason: 'Commercial settlement',
        date: '2026-08-21',
      },
      adminCookie,
      `${suffix}-discount`,
    );
    expect(adjustment.statusCode, adjustment.body).toBe(201);
    const settled = (await call('GET', `/invoices/${invoice.id}`)).json<TestEnvelope>().data;
    expect(settled).toMatchObject({
      dueAmount: '0.00',
      receivedAmount: '100.00',
      adjustmentAmount: '5.00',
      paymentStatus: 'PAID',
      taxTotal: '5.00',
    });
    expect(
      (await call('POST', `/invoices/${invoice.id}/cancel`, { reason: 'Correction' })).statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', `/receipts/${receipt.json<TestEnvelope>().data.id}/reverse`, {
          reason: 'Cheque returned',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/settlement-adjustments/${adjustment.json<TestEnvelope>().data.id}/reverse`,
          { reason: 'Settlement withdrawn' },
        )
      ).statusCode,
    ).toBe(200);
    const cancellation = await call('POST', `/invoices/${invoice.id}/cancel`, {
      reason: 'Cancelled after reversal',
    });
    expect(cancellation.statusCode).toBe(200);
    expect(
      (
        await call('PUT', `/invoices/${invoice.id}`, {
          ...draft(),
          version: cancellation.json<TestEnvelope>().data.version,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await call('GET', `/invoices/${invoice.id}`)).json<TestEnvelope>().data.paymentStatus,
    ).toBe('NOT_APPLICABLE');
  });
  it('requires review when tax rules change after a draft was saved', async () => {
    const invoice = await create('/invoices', draft());
    const change = await call('PUT', `/tax-rules/${rateId}`, {
      name: 'IGST changed',
      component: 'IGST',
      serviceCategoryId: categoryId,
      rate: '6',
      effectiveFrom: '2026-01-01',
      version: 1,
    });
    expect(change.statusCode, change.body).toBe(200);
    const issue = await call('POST', `/invoices/${invoice.id}/issue`, { version: 1 });
    expect(issue.statusCode, issue.body).toBe(409);
    expect(issue.json<TestEnvelope>().error.code).toBe('DRAFT_TAXES_CHANGED');
    const update = await call('PUT', `/invoices/${invoice.id}`, { ...draft(), version: 1 });
    expect(update.statusCode, update.body).toBe(200);
    const reviewed = await call('POST', `/invoices/${invoice.id}/issue`, { version: 2 });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(reviewed.json<TestEnvelope>().data.taxTotal).toBe('4890.00');
    expect(reviewed.json<TestEnvelope>().data.lines[0]!.appliedTaxes[0]).toMatchObject({
      ruleId: rateId,
      component: 'IGST',
      rate: '6.00',
      amount: '4890.00',
    });
    const changedAgain = await call('PUT', `/tax-rules/${rateId}`, {
      name: 'IGST changed again',
      component: 'IGST',
      serviceCategoryId: categoryId,
      rate: '7',
      effectiveFrom: '2026-01-01',
      version: 2,
    });
    expect(changedAgain.statusCode, changedAgain.body).toBe(200);
    const historical = (await call('GET', `/invoices/${invoice.id}`)).json<TestEnvelope>().data;
    expect(historical.lines[0]!.appliedTaxes[0]).toMatchObject({
      ruleId: rateId,
      component: 'IGST',
      rate: '6.00',
      amount: '4890.00',
    });
  });
  it('supports remaining masters and one shared vehicle entity across both applications', async () => {
    const guest = await create('/guests', {
      name: 'Guest',
      market: 'INTERNATIONAL',
      legacyLastAmountPaid: '100.00',
    });
    expect(guest.market).toBe('INTERNATIONAL');
    const hotel = await create('/hotels', { name: 'Hotel', market: 'DOMESTIC' });
    await create('/hotel-rates', {
      hotelId: hotel.id,
      name: 'CPAI 2026',
      plan: 'CPAI',
      amount: '1500.00',
      currency: 'INR',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
    });
    const vendor = await create('/vendors', { name: `Shared Vendor ${suffix}` });
    const vendorProfile = await create('/vendor-profiles', {
      vendorId: vendor.id,
      city: 'City',
      market: 'DOMESTIC',
    });
    expect(vendorProfile.vendorId).toBe(vendor.id);
    const vehicle = await create('/vehicles', {
      registrationNumber: `CORE${suffix}`,
      displayName: 'Core Vehicle',
      vehicleType: 'SEDAN',
      registeredOwner: 'Owner',
      accountNumber: '000123',
      ifscCode: 'test0000123',
    });
    expect(vehicle).toMatchObject({
      vehicleType: 'SEDAN',
      registeredOwner: 'Owner',
      accountNumber: '000123',
      ifscCode: 'TEST0000123',
    });
    const feedback = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/vehicles/${vehicle.id}`,
      headers: { cookie: feedbackCookie },
    });
    expect(feedback.statusCode).toBe(200);
    expect(feedback.json<TestEnvelope>().data).toMatchObject({
      id: vehicle.id,
      vehicleType: 'SEDAN',
      registeredOwner: 'Owner',
      accountNumber: '000123',
    });
    expect((await call('GET', '/vehicle-profiles')).statusCode).toBe(404);
  });
  it('imports legacy invoices without renumbering or recalculating taxes', async () => {
    const admin = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: adminCookie },
    });
    const actorId = admin.json<{ data: { user: { accountId: string } } }>().data.user.accountId;
    const input = draft('100.00');
    const record = {
      source: `legacy-${suffix}`,
      sourceTable: 'InvoiceMaster',
      sourceId: '13930',
      invoiceNumber: '13930',
      rawRecord: { InvoiceNumber: 13930 },
      invoice: input,
      snapshot: {
        company: { name: 'Historic Company' },
        customer: { name: 'Historic Agent' },
        serviceCategory: { code: '9985' },
        bankAccounts: [{ name: 'Historic Bank', accountNumber: '00001234' }],
      },
      lines: [
        {
          position: 1,
          description: input.lines[0]!.description,
          amount: '100.00',
          taxTreatment: 'TAXABLE',
          taxes: [{ component: 'IGST', rate: '5', amount: '4.99' }],
          taxAmount: '4.99',
          total: '104.99',
        },
      ],
      subtotal: '100.00',
      taxTotal: '4.99',
      grandTotal: '104.99',
    };
    const imported = await importLegacyInvoice(database.db, record, actorId);
    expect(imported.alreadyImported).toBe(false);
    const repeated = await importLegacyInvoice(database.db, record, actorId);
    expect(repeated).toEqual({ id: imported.id, alreadyImported: true });
    const result = (await call('GET', `/invoices/${imported.id}`)).json<TestEnvelope>().data;
    expect(result).toMatchObject({
      invoiceNumber: '13930',
      taxTotal: '4.99',
      grandTotal: '104.99',
    });
    await expect(
      importLegacyInvoice(database.db, { ...record, rawRecord: { InvoiceNumber: 13931 } }, actorId),
    ).rejects.toThrow('different content');
  });
  it('serves category-filtered customer pickers, receivables and guest activity', async () => {
    const filtered = await call('GET', '/customers?category=CORPORATE&q=Agent');
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json<{ data: unknown[] }>().data).toEqual([]);
    const report = await call('GET', '/reports/receivables', undefined, viewerCookie);
    expect(report.statusCode, report.body).toBe(200);
    const rows = report.json<{
      data: { dueAmount: string; receivedAmount: string }[];
      pagination: { total: number };
    }>();
    expect(rows.pagination.total).toBeGreaterThan(0);
    expect(rows.data[0]!.receivedAmount).toMatch(/^\d+\.\d{2}$/);
    const empty = await call('GET', '/reports/receivables?page=1000000');
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json<{ pagination: { total: number } }>().pagination.total).toBe(
      rows.pagination.total,
    );
    const guest = await create('/guests', {
      name: 'Guest history',
      legacyLastServiceAvailed: 'Old tour',
      legacyLastAmountPaid: '500.00',
    });
    const activity = await call('GET', `/guests/${guest.id}/activity`);
    expect(activity.statusCode, activity.body).toBe(200);
    expect(activity.json<TestEnvelope>().data).toMatchObject({
      lastService: null,
      lastPayment: null,
      legacyLastAmountPaid: '500.00',
    });
    const overlap = await call('POST', '/tax-rules', {
      name: 'Overlapping IGST',
      component: 'IGST',
      serviceCategoryId: categoryId,
      rate: '7',
      effectiveFrom: '2026-01-01',
    });
    expect(overlap.statusCode, overlap.body).toBe(409);
  });
  it('serves the Core dashboard and every detailed financial report', async () => {
    const period = 'from=2026-01-01&to=2026-12-31';
    const endpoints = [
      `/reports/invoices?${period}&customerCategory=AGENT&sortBy=grandTotal`,
      `/reports/vehicle-invoices?${period}&sortBy=grandTotal`,
      `/reports/taxes?${period}&component=IGST&sortBy=taxAmount`,
      `/reports/payments-received?${period}&sortBy=amount`,
      `/reports/receivables?${period}&sortBy=dueAmount`,
      `/reports/settlement-discounts?${period}&sortBy=amount`,
    ];
    for (const endpoint of endpoints) {
      const response = await call('GET', endpoint, undefined, viewerCookie);
      expect(response.statusCode, `${endpoint}: ${response.body}`).toBe(200);
      const body = response.json<{
        data: unknown[];
        summary: Record<string, unknown>;
        pagination: { total: number };
        meta: { currency: string; balanceBasis: string };
      }>();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.summary).toBeTypeOf('object');
      expect(body.pagination.total).toBeGreaterThanOrEqual(0);
      expect(body.meta).toMatchObject({ currency: 'INR', balanceBasis: 'CURRENT' });
    }
    const exports = [
      `/reports/invoices/export?${period}`,
      `/reports/vehicle-invoices/export?${period}`,
      `/reports/taxes/export?${period}`,
      `/reports/payments-received/export?${period}`,
      `/reports/receivables/export?${period}`,
      `/reports/settlement-discounts/export?${period}`,
    ];
    for (const endpoint of exports) {
      const response = await call('GET', endpoint, undefined, viewerCookie);
      expect(response.statusCode, `${endpoint}: ${response.body}`).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
    }

    const invoiceExport = await call(
      'GET',
      `/reports/invoices/export?${period}`,
      undefined,
      viewerCookie,
    );
    const invoiceHeaders = invoiceExport.body.replace(/^\uFEFF/, '').split('\r\n')[0];
    expect(invoiceHeaders).toContain('"Invoice Number"');
    expect(invoiceHeaders).toContain('"Customer Category"');
    expect(invoiceHeaders).toContain('"Grand Total (INR)"');
    expect(invoiceHeaders).not.toMatch(/"(?:invoice|company|customer|serviceCategory|vehicle)Id"/);
    expect(invoiceHeaders).not.toContain('"issuedAt"');
    expect(invoiceHeaders).not.toContain('"cancelledAt"');

    const vehicleInvoiceExport = await call(
      'GET',
      `/reports/vehicle-invoices/export?${period}`,
      undefined,
      viewerCookie,
    );
    const vehicleInvoiceHeaders = vehicleInvoiceExport.body.replace(/^\uFEFF/, '').split('\r\n')[0];
    expect(vehicleInvoiceHeaders).toContain('"Vehicle Registration Number"');
    expect(vehicleInvoiceHeaders).toContain('"Invoice Count"');
    expect(vehicleInvoiceHeaders).not.toContain('"vehicleId"');

    const dashboard = await call('GET', `/reports/dashboard?${period}`, undefined, viewerCookie);
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const cards = dashboard.json<{ data: { cards: Record<string, unknown> } }>().data.cards;
    expect(typeof cards.issuedInvoiceCount).toBe('number');
    expect(cards.invoicedAmount).toMatch(/^\d+\.\d{2}$/);
    expect(cards.outstandingNow).toMatch(/^\d+\.\d{2}$/);

    const statement = await call(
      'GET',
      `/reports/customers/${customerId}/statement?${period}`,
      undefined,
      viewerCookie,
    );
    expect(statement.statusCode, statement.body).toBe(200);
    const statementData = statement.json<{
      data: { customer: { id: string }; entries: unknown[] };
    }>().data;
    expect(statementData.customer.id).toBe(customerId);
    expect(Array.isArray(statementData.entries)).toBe(true);
    expect(
      (
        await call(
          'GET',
          `/reports/customers/${customerId}/statement/export?${period}`,
          undefined,
          viewerCookie,
        )
      ).headers['content-type'],
    ).toContain('text/csv');

    expect(
      (await call('GET', `/reports/audit?${period}`, undefined, viewerCookie)).statusCode,
    ).toBe(403);
    const audit = await call('GET', `/reports/audit?${period}`);
    expect(audit.statusCode, audit.body).toBe(200);
    const auditExport = await call('GET', `/reports/audit/export?${period}`);
    expect(auditExport.statusCode, auditExport.body).toBe(200);
    expect(auditExport.headers['content-type']).toContain('text/csv');
  });
  it('manages core accounts without returning credentials or granting feedback access', async () => {
    const user = await create('/users', {
      username: `managed-${suffix}`,
      email: `managed-${suffix}@example.com`,
      displayName: 'Managed',
      password,
      role: 'CORE_DATA_ENTRY',
    });
    expect(user.passwordHash).toBeUndefined();
    const duplicate = await call('POST', '/users', {
      username: `managed-${suffix}`,
      email: `different-${suffix}@example.com`,
      displayName: 'Duplicate',
      password,
      role: 'CORE_DATA_ENTRY',
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/core/login',
      payload: { username: `managed-${suffix}`, password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const changed = await call('PATCH', `/users/${user.id}/access`, {
      role: 'CORE_REPORT_VIEWER',
      status: 'ACTIVE',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await call('GET', '/companies', undefined, cookie)).statusCode).toBe(401);
    expect(
      (
        await call('POST', `/users/${user.id}/password-reset`, {
          password: 'new-secure-password-123',
        })
      ).statusCode,
    ).toBe(204);
  });
});
