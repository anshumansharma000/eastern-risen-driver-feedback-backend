import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { announcementRoutes } from './announcements.routes.js';
import { createCoreGuards } from './access.js';
import type { CoreServices } from '../index.js';
import errorHandler from '../../../plugins/error-handler.js';
import originProtection from '../../../plugins/origin-protection.js';
const id = '00000000-0000-4000-8000-000000000001';
const input = {
  name: 'Internal campaign name',
  category: 'GENERAL',
  message: 'Discover Odisha.',
  linkText: 'Explore',
  linkUrl: '/tours',
  status: 'PUBLISHED',
  startsAt: '2026-10-01T00:00:00.000Z',
  endsAt: null,
  placement: 'PUBLIC',
  paths: [],
  priority: 'IMPORTANT',
  dismissible: false,
};
const record = {
  ...input,
  id,
  version: 2,
  startsAt: new Date(input.startsAt),
  createdAt: new Date(input.startsAt),
  updatedAt: new Date(input.startsAt),
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function setup(role?: string) {
  const app = Fastify();
  apps.push(app);
  await app.register(originProtection, { allowedOrigins: ['https://website.test'] });
  await app.register(errorHandler);
  app.decorateRequest('auth', null);
  const announcements = {
    active: vi.fn(async () => [record]),
    list: vi.fn(async () => ({ items: [record], total: 1 })),
    create: vi.fn(async () => record),
    update: vi.fn(async () => record),
  };
  const services = {
    announcements,
    guards: createCoreGuards(async (request) => {
      if (role) request.auth = { role, accountId: id } as NonNullable<typeof request.auth>;
    }),
  } as unknown as CoreServices;
  await app.register(announcementRoutes, { prefix: '/api/v1/core', services });
  return { app, announcements };
}
describe('core announcement API', () => {
  it('provides anonymous current content without internal fields', async () => {
    const { app, announcements } = await setup();
    const response = await app.inject('/api/v1/core/public/announcements?page=%2Ftours%2F');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=0, s-maxage=30');
    expect(announcements.active).toHaveBeenCalledWith('/tours', expect.any(Date));
    expect(response.json<{ data: unknown[] }>().data[0]).toEqual({
      id,
      revision: 2,
      category: 'GENERAL',
      message: input.message,
      linkText: 'Explore',
      linkUrl: '/tours',
      priority: 'IMPORTANT',
      dismissible: false,
      startsAt: input.startsAt,
      endsAt: null,
    });
    expect(response.body).not.toContain(input.name);
    expect(response.body).not.toContain('createdAt');
  });
  it.each([undefined, 'DRIVER', 'ADMIN', 'CORE_REPORT_VIEWER', 'CORE_DATA_ENTRY'])(
    'denies management for %s',
    async (role) => {
      const { app, announcements } = await setup(role);
      expect((await app.inject('/api/v1/core/announcements')).statusCode).toBe(403);
      expect((await app.inject('/api/v1/core/announcements/active')).statusCode).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/core/announcements', payload: input }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/core/announcements/${id}`,
            payload: { ...input, version: 2 },
          })
        ).statusCode,
      ).toBe(403);
      expect(announcements.create).not.toHaveBeenCalled();
      expect(announcements.update).not.toHaveBeenCalled();
    },
  );
  it('supports paginated admin reads and versioned writes', async () => {
    const { app, announcements } = await setup('CORE_ADMIN');
    expect(
      (await app.inject('/api/v1/core/announcements?page=2&pageSize=10')).json<{
        pagination: unknown;
      }>().pagination,
    ).toEqual({ page: 2, pageSize: 10, total: 1 });
    expect(announcements.list).toHaveBeenCalledWith(2, 10);
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/core/announcements', payload: input }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/core/announcements/${id}`,
          payload: { ...input, version: 2 },
        })
      ).statusCode,
    ).toBe(200);
    expect(announcements.update).toHaveBeenCalledWith(id, input, 2, id);
    expect((await app.inject('/api/v1/core/announcements/active')).headers['cache-control']).toBe(
      'no-store',
    );
  });
  it.each([
    { ...input, message: 'x'.repeat(141) },
    { ...input, category: 'OTHER' },
    { ...input, startsAt: 'invalid' },
    { ...input, priority: 'CRITICAL' },
  ])('rejects malformed announcement fields', async (payload) => {
    const { app, announcements } = await setup('CORE_ADMIN');
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/core/announcements', payload })).statusCode,
    ).toBe(400);
    expect(announcements.create).not.toHaveBeenCalled();
  });
  it('rejects private placement and disallowed write origins', async () => {
    const { app, announcements } = await setup('CORE_ADMIN');
    expect(
      (await app.inject('/api/v1/core/public/announcements?page=%2Fquote%2Fsecret')).statusCode,
    ).toBe(422);
    expect(announcements.active).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/core/announcements',
          payload: input,
          headers: { origin: 'https://evil.test' },
        })
      ).statusCode,
    ).toBe(403);
  });
});
