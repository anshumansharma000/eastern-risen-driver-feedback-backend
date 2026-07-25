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
    const body = response.json<{ error: { code: string; message: string; requestId: string } }>();

    expect(response.statusCode).toBe(404);
    expect(body).toMatchObject({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route GET /missing was not found',
      },
    });
    expect(body.error.requestId).toBeTruthy();
    expect(response.headers['x-request-id']).toBe(body.error.requestId);
  });

  it('normalizes framework HTTP errors into the standard envelope', async () => {
    app = await buildApp({ exposeDocs: false });
    app.get('/test-http-error', async () => {
      throw Object.assign(new Error('raw framework message'), { statusCode: 413 });
    });

    const response = await app.inject({ method: 'GET', url: '/test-http-error' });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: {
        code: 'REQUEST_BODY_TOO_LARGE',
        message: 'The request body is too large',
        requestId: response.headers['x-request-id'],
      },
    });
    expect(response.body).not.toContain('raw framework message');
  });

  it('documents the shared error response in OpenAPI', async () => {
    app = await buildApp({ exposeDocs: true });

    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    const document = response.json<{
      components: { schemas: Record<string, { required?: string[] }> };
      paths: { '/health/live': { get: { responses: Record<string, unknown> } } };
    }>();

    expect(response.statusCode, response.body).toBe(200);
    expect(
      Object.values(document.components.schemas).some((schema) =>
        schema.required?.includes('error'),
      ),
    ).toBe(true);
    expect(document.paths['/health/live'].get.responses['500']).toBeTruthy();
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

  it('allows PUT requests from the configured frontend during CORS preflight', async () => {
    app = await buildApp({ exposeDocs: false, allowedOrigins: ['http://localhost:3000'] });

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/admin/questionnaires/questionnaire-id/versions/version-id/questions',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-methods']?.split(', ')).toContain('PUT');
    expect(response.headers['access-control-allow-headers']).toBe('content-type');
  });
});
