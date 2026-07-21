import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('application infrastructure', () => {
  it('reports process liveness', async () => {
    app = await buildApp({ exposeDocs: false });

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'driver-feedback-api',
    });
  });

  it('reports database readiness', async () => {
    const databaseHealthCheck = vi.fn().mockResolvedValue(undefined);
    app = await buildApp({ exposeDocs: false, databaseHealthCheck });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(databaseHealthCheck).toHaveBeenCalledOnce();
  });

  it('returns service unavailable when the database check fails', async () => {
    app = await buildApp({
      exposeDocs: false,
      databaseHealthCheck: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'unavailable' });
  });

  it('uses a stable error envelope for unknown routes', async () => {
    app = await buildApp({ exposeDocs: false });

    const response = await app.inject({ method: 'GET', url: '/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'ROUTE_NOT_FOUND' },
    });
  });

  it('rejects state-changing requests from unapproved browser origins', async () => {
    app = await buildApp({ exposeDocs: false, allowedOrigins: ['http://localhost:3001'] });

    const response = await app.inject({
      method: 'POST',
      url: '/missing',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
  });

  it('returns credentialed CORS headers for the configured frontend', async () => {
    app = await buildApp({ exposeDocs: false, allowedOrigins: ['http://localhost:3001'] });

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/me',
      headers: {
        origin: 'http://localhost:3001',
        'access-control-request-method': 'GET',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});
