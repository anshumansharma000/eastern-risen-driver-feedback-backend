import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import { auditEvents, authAccounts, drivers, vendors } from '../src/database/schema/index.js';
import { passwordHasher } from '../src/modules/auth/password.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('authentication and admin APIs', () => {
  let app: FastifyInstance;
  let database: DatabaseClient;
  let adminAccountId: string;
  let driverAccountId: string | undefined;
  let driverId: string | undefined;
  let vendorId: string | undefined;
  const suffix = Date.now().toString(36);
  const adminEmail = `integration-admin-${suffix}@example.com`;
  const driverEmail = `integration-driver-${suffix}@example.com`;
  const driverCode = `TEST-${suffix}`;
  const password = 'integration-password-123';

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      SESSION_TTL_HOURS: '12',
    });
    database = createDatabaseClient(config);
    const [admin] = await database.db
      .insert(authAccounts)
      .values({
        role: 'ADMIN',
        displayName: 'Integration Admin',
        email: adminEmail,
        passwordHash: await passwordHasher.hash(password),
      })
      .returning({ id: authAccounts.id });
    adminAccountId = admin!.id;
    app = await buildApp({
      exposeDocs: false,
      services: createApplicationServices(database.db, config),
    });
  });

  afterAll(async () => {
    await app?.close();
    await database.db.delete(auditEvents).where(eq(auditEvents.actorAccountId, adminAccountId));
    if (driverId) await database.db.delete(drivers).where(eq(drivers.id, driverId));
    if (driverAccountId) {
      await database.db.delete(authAccounts).where(eq(authAccounts.id, driverAccountId));
    }
    await database.db.delete(authAccounts).where(eq(authAccounts.id, adminAccountId));
    if (vendorId) await database.db.delete(vendors).where(eq(vendors.id, vendorId));
    await database.close();
  });

  it('authenticates an admin and manages a vendor and driver', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: adminEmail, password },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie)
      ? setCookie[0]?.split(';', 1)[0]
      : setCookie?.split(';', 1)[0];
    expect(cookie).toBeTruthy();

    const vendorResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/vendors',
      headers: { cookie: cookie! },
      payload: { name: `Integration Vendor ${suffix}` },
    });
    expect(vendorResponse.statusCode).toBe(201);
    vendorId = vendorResponse.json<{ data: { id: string } }>().data.id;

    const vendorUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/vendors/${vendorId}`,
      headers: { cookie: cookie! },
      payload: { contactName: 'Updated Contact' },
    });
    expect(vendorUpdate.statusCode).toBe(200);
    expect(vendorUpdate.json()).toMatchObject({ data: { contactName: 'Updated Contact' } });

    const driverResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/drivers',
      headers: { cookie: cookie! },
      payload: {
        displayName: 'Integration Driver',
        email: driverEmail,
        password,
        driverCode,
        sourceType: 'OUTSOURCED',
        vendorId,
      },
    });
    expect(driverResponse.statusCode).toBe(201);
    const driver = driverResponse.json<{
      data: { id: string; accountId: string; vendorName: string | null };
    }>().data;
    expect(driver.vendorName).toBe(`Integration Vendor ${suffix}`);
    driverId = driver.id;
    driverAccountId = driver.accountId;

    const driverLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/driver/login',
      payload: { driverCode, password },
    });
    expect(driverLogin.statusCode).toBe(200);

    const driverUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/drivers/${driverId}`,
      headers: { cookie: cookie! },
      payload: { phone: '+91-9999999999' },
    });
    expect(driverUpdate.statusCode).toBe(200);
    expect(driverUpdate.json()).toMatchObject({ data: { phone: '+91-9999999999' } });

    const deactivate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/drivers/${driverId}/status`,
      headers: { cookie: cookie! },
      payload: { status: 'DEACTIVATED' },
    });
    expect(deactivate.statusCode).toBe(200);

    const blockedLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/driver/login',
      payload: { driverCode, password },
    });
    expect(blockedLogin.statusCode).toBe(401);
    expect(blockedLogin.json()).toMatchObject({ error: { code: 'AUTHENTICATION_FAILED' } });

    const auditRows = await database.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.actorAccountId, adminAccountId));
    expect(auditRows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'VENDOR_CREATED',
        'VENDOR_UPDATED',
        'DRIVER_CREATED',
        'DRIVER_UPDATED',
        'DRIVER_STATUS_CHANGED',
      ]),
    );
  }, 20_000);

  it('rejects admin APIs without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/drivers' });
    expect(response.statusCode).toBe(401);
  });
});
