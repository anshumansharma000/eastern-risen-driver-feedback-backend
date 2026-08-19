import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createApplicationServices } from '../src/container.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import {
  auditEvents,
  authAccounts,
  authSessions,
  drivers,
  vendors,
} from '../src/database/schema/index.js';
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
  const changedDriverPassword = 'integration-password-456';
  const resetDriverPassword = 'integration-password-789';
  const changedAdminPassword = 'integration-admin-password-456';

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      SESSION_IDLE_TTL_HOURS: '72',
      SESSION_ABSOLUTE_TTL_DAYS: '30',
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
    await database.db.delete(auditEvents).where(
      or(
        inArray(
          auditEvents.actorAccountId,
          [adminAccountId, driverAccountId].filter((id): id is string => Boolean(id)),
        ),
        ...(driverId ? [eq(auditEvents.entityId, driverId)] : []),
        ...(driverAccountId ? [eq(auditEvents.entityId, driverAccountId)] : []),
      ),
    );
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
        license: {
          licenseNumber: `LIC-${suffix}`,
          issuedOn: '2025-01-01',
          expiresOn: '2030-01-01',
          issuingAuthority: 'West Bengal Transport Department',
          categories: ['LMV'],
        },
      },
    });
    expect(driverResponse.statusCode, driverResponse.body).toBe(201);
    const driver = driverResponse.json<{
      data: {
        id: string;
        accountId: string;
        vendorName: string | null;
        license: { licenseNumber: string; categories: string[] };
      };
    }>().data;
    expect(driver.vendorName).toBe(`Integration Vendor ${suffix}`);
    expect(driver.license).toMatchObject({ licenseNumber: `LIC-${suffix}`, categories: ['LMV'] });
    driverId = driver.id;
    driverAccountId = driver.accountId;

    const driverUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/drivers/${driverId}`,
      headers: { cookie: cookie! },
      payload: { phone: '+919999999999' },
    });
    expect(driverUpdate.statusCode).toBe(200);
    expect(driverUpdate.json()).toMatchObject({ data: { phone: '+919999999999' } });

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

    const reactivate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/drivers/${driverId}/status`,
      headers: { cookie: cookie! },
      payload: { status: 'ACTIVE' },
    });
    expect(reactivate.statusCode).toBe(200);

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

  it('supports admin and driver profiles plus secure driver password lifecycle', async () => {
    const adminCookie = await login('/api/v1/auth/admin/login', {
      email: adminEmail,
      password,
    });
    const driverCookie = await login('/api/v1/auth/driver/login', {
      driverCode,
      password,
    });

    const driverDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/drivers/${driverId}`,
      headers: { cookie: adminCookie },
    });
    expect(driverDetail.statusCode, driverDetail.body).toBe(200);
    expect(driverDetail.json()).toMatchObject({
      data: { id: driverId, accountId: driverAccountId, driverCode },
    });

    const adminProfile = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/profile',
      headers: { cookie: adminCookie },
    });
    expect(adminProfile.statusCode, adminProfile.body).toBe(200);
    expect(adminProfile.json()).toMatchObject({
      data: { accountId: adminAccountId, role: 'ADMIN', email: adminEmail },
    });
    const adminProfileUpdate = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/profile',
      headers: { cookie: adminCookie },
      payload: { displayName: 'Updated Integration Admin' },
    });
    expect(adminProfileUpdate.statusCode, adminProfileUpdate.body).toBe(200);
    expect(adminProfileUpdate.json()).toMatchObject({
      data: { displayName: 'Updated Integration Admin' },
    });

    const driverProfile = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/profile',
      headers: { cookie: driverCookie },
    });
    expect(driverProfile.statusCode, driverProfile.body).toBe(200);
    expect(driverProfile.json()).toMatchObject({
      data: {
        accountId: driverAccountId,
        driverId,
        role: 'DRIVER',
        sourceType: 'OUTSOURCED',
        vendorId,
      },
    });
    const driverProfileUpdate = await app.inject({
      method: 'PATCH',
      url: '/api/v1/driver/profile',
      headers: { cookie: driverCookie },
      payload: { displayName: 'Driver Self Updated', phone: '+918888888888' },
    });
    expect(driverProfileUpdate.statusCode, driverProfileUpdate.body).toBe(200);
    expect(driverProfileUpdate.json()).toMatchObject({
      data: { displayName: 'Driver Self Updated', phone: '+918888888888' },
    });

    const changeDriverPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/profile/change-password',
      headers: { cookie: driverCookie },
      payload: { currentPassword: password, newPassword: changedDriverPassword },
    });
    expect(changeDriverPassword.statusCode, changeDriverPassword.body).toBe(204);
    const revokedDriverSession = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/profile',
      headers: { cookie: driverCookie },
    });
    expect(revokedDriverSession.statusCode).toBe(401);
    const changedPasswordCookie = await login('/api/v1/auth/driver/login', {
      driverCode,
      password: changedDriverPassword,
    });

    const adminReset = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/password-reset`,
      headers: { cookie: adminCookie },
      payload: { newPassword: resetDriverPassword },
    });
    expect(adminReset.statusCode, adminReset.body).toBe(204);

    const revokedByAdmin = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/profile',
      headers: { cookie: changedPasswordCookie },
    });
    expect(revokedByAdmin.statusCode).toBe(401);

    const supersededPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/driver/login',
      payload: { driverCode, password: changedDriverPassword },
    });
    expect(supersededPassword.statusCode).toBe(401);
    await login('/api/v1/auth/driver/login', {
      driverCode,
      password: resetDriverPassword,
    });
    const [resetAudit] = await database.db
      .select({
        action: auditEvents.action,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.entityId, driverId!), eq(auditEvents.action, 'DRIVER_PASSWORD_RESET')),
      )
      .limit(1);
    const resetAuditText = JSON.stringify(resetAudit?.metadata);
    expect(resetAudit?.action).toBe('DRIVER_PASSWORD_RESET');
    expect(resetAuditText).not.toContain(resetDriverPassword);

    const publicResetRequest = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/driver/password-reset/request',
      payload: { email: driverEmail },
    });
    expect(publicResetRequest.statusCode).toBe(404);
  }, 30_000);

  it('rejects admin APIs without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/drivers' });
    expect(response.statusCode).toBe(401);
  });

  it('rotates an active session while briefly accepting its previous token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: adminEmail, password },
    });
    const originalSetCookie = login.headers['set-cookie'];
    const originalCookie = (
      Array.isArray(originalSetCookie) ? originalSetCookie[0] : originalSetCookie
    )?.split(';', 1)[0];
    expect(originalCookie).toBeTruthy();

    await database.db
      .update(authSessions)
      .set({ rotatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(authSessions.accountId, adminAccountId));

    const renewal = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: originalCookie! },
    });
    expect(renewal.statusCode).toBe(200);
    const renewedSetCookie = renewal.headers['set-cookie'];
    const renewedCookie = (
      Array.isArray(renewedSetCookie) ? renewedSetCookie[0] : renewedSetCookie
    )?.split(';', 1)[0];
    expect(renewedCookie).toBeTruthy();
    expect(renewedCookie).not.toBe(originalCookie);

    const concurrentOldTokenRequest = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: originalCookie! },
    });
    expect(concurrentOldTokenRequest.statusCode).toBe(200);

    const renewedTokenRequest = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: renewedCookie! },
    });
    expect(renewedTokenRequest.statusCode).toBe(200);
  });

  it('changes the administrator password and revokes the current session', async () => {
    const adminCookie = await login('/api/v1/auth/admin/login', {
      email: adminEmail,
      password,
    });
    const change = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/profile/change-password',
      headers: { cookie: adminCookie },
      payload: { currentPassword: password, newPassword: changedAdminPassword },
    });
    expect(change.statusCode, change.body).toBe(204);
    const revoked = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/profile',
      headers: { cookie: adminCookie },
    });
    expect(revoked.statusCode).toBe(401);
    await login('/api/v1/auth/admin/login', {
      email: adminEmail,
      password: changedAdminPassword,
    });
  });

  async function login(url: string, payload: Record<string, string>): Promise<string> {
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode, response.body).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return cookie!.split(';', 1)[0]!;
  }
});
