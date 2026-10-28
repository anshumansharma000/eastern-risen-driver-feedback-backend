import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inquiryRoutes } from './inquiries.routes.js';
import { createCoreGuards } from './access.js';
import type { CoreServices } from '../index.js';
import originProtection from '../../../plugins/origin-protection.js';
import errorHandler from '../../../plugins/error-handler.js';

const id = '00000000-0000-4000-8000-000000000001';
const contact = {
  submissionId: id,
  type: 'CONTACT',
  fullName: ' Jane Doe ',
  email: 'JANE@example.com',
  phone: '+91 1234567890',
  message: 'Hello',
  pageUrl: 'https://example.com/contact/?private=yes#token=secret',
};
const tour = {
  ...contact,
  type: 'TOUR',
  country: 'India',
  contactMethod: 'Email',
  travelDates: 'Flexible',
  adults: '10+',
  children: '6+',
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function setup(role?: string) {
  const app = Fastify();
  apps.push(app);
  await app.register(rateLimit, { global: false });
  await app.register(originProtection, { allowedOrigins: ['https://example.com'] });
  await app.register(errorHandler);
  app.decorateRequest('auth', null);
  const create = vi.fn(async () => ({ id, createdAt: new Date('2026-10-27T00:00:00Z') }));
  const list = vi.fn(async () => ({ items: [], total: 0 }));
  const services = {
    inquiries: { create, list },
    guards: createCoreGuards(async (request) => {
      if (role) request.auth = { role } as NonNullable<typeof request.auth>;
    }),
  } as unknown as CoreServices;
  await app.register(inquiryRoutes, { prefix: '/api/v1/core', services });
  return { app, create, list };
}
const post = (app: ReturnType<typeof Fastify>, payload: object) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/core/public/inquiries',
    payload,
    headers: { origin: 'https://example.com' },
  });
describe('core inquiry collection', () => {
  it('confirms persisted contact details and only returns a receipt', async () => {
    const { app, create } = await setup();
    const response = await post(app, contact);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ data: { id, createdAt: '2026-10-27T00:00:00.000Z' } });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        fullName: 'Jane Doe',
        email: 'jane@example.com',
        details: { message: 'Hello', pageUrl: 'https://example.com/contact/' },
      }),
    );
  });
  it('accepts general and specific tour plans including open-ended party sizes', async () => {
    const { app } = await setup();
    expect((await post(app, tour)).statusCode).toBe(201);
    expect(
      (
        await post(app, {
          ...tour,
          type: 'TOUR_DETAIL',
          tourTitle: 'Odisha',
          region: 'India',
          duration: '7 days',
        })
      ).statusCode,
    ).toBe(201);
  });
  it.each([
    { ...contact, email: 'invalid' },
    { ...contact, fullName: ' ' },
    { ...contact, message: '' },
    { ...contact, website: 'spam' },
    { ...contact, phone: 'x'.repeat(65) },
    { ...tour, adults: '-1' },
    { ...tour, type: 'TOUR_DETAIL' },
    { ...tour, country: '' },
    { ...contact, pageUrl: 'javascript:alert(1)' },
  ])('rejects invalid data without storing it', async (payload) => {
    const { app, create } = await setup();
    expect([400, 422]).toContain((await post(app, payload)).statusCode);
    expect(create).not.toHaveBeenCalled();
  });
  it('does not report success when persistence fails', async () => {
    const { app, create } = await setup();
    create.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await post(app, contact)).statusCode).toBe(500);
  });
  it('rate limits public submissions', async () => {
    const { app, create } = await setup();
    for (let i = 0; i < 5; i++) expect((await post(app, contact)).statusCode).toBe(201);
    expect((await post(app, contact)).statusCode).toBe(429);
    expect(create).toHaveBeenCalledTimes(5);
  });
  it('rejects an unapproved website origin', async () => {
    const { app, create } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/core/public/inquiries',
      payload: contact,
      headers: { origin: 'https://untrusted.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
  it.each([undefined, 'DRIVER', 'ADMIN'])(
    'denies inquiry reads to non-core users (%s)',
    async (role) => {
      const { app, list } = await setup(role);
      expect((await app.inject('/api/v1/core/inquiries')).statusCode).toBe(403);
      expect((await app.inject(`/api/v1/core/inquiries/${id}`)).statusCode).toBe(403);
      expect(list).not.toHaveBeenCalled();
    },
  );
  it.each(['CORE_ADMIN', 'CORE_DATA_ENTRY', 'CORE_REPORT_VIEWER'])(
    'allows paginated core staff reads (%s)',
    async (role) => {
      const { app, list } = await setup(role);
      const response = await app.inject('/api/v1/core/inquiries?page=2&pageSize=10');
      expect(response.statusCode).toBe(200);
      expect(list).toHaveBeenCalledWith(2, 10);
      expect(response.json()).toEqual({
        data: [],
        pagination: { page: 2, pageSize: 10, total: 0 },
      });
    },
  );
});
