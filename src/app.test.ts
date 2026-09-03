import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { buildApp } from './app.js';
import { AppError } from './shared/errors/app-error.js';

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
    const logs: string[] = [];
    app = await buildApp({
      exposeDocs: false,
      databaseHealthCheck: vi.fn().mockRejectedValue(new Error('database unavailable')),
      logger: { level: 'error', stream: logStream(logs) },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'unavailable' });
    expect(logs.join('')).toContain('Database readiness check failed');
    expect(logs.join('')).toContain('database unavailable');
    expect(logs.join('')).toContain(response.headers['x-request-id']);
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
        message: 'The submitted information is too large',
        developerMessage: 'The request exceeded the configured HTTP body-size limit.',
        requestId: response.headers['x-request-id'],
      },
    });
    expect(response.body).not.toContain('raw framework message');
  });

  it('returns normalized field validation errors without exposing validator internals', async () => {
    app = await buildApp({ exposeDocs: false });
    app.post(
      '/test-validation',
      { schema: { body: Type.Object({ email: Type.String({ format: 'email' }) }) } },
      async () => ({ ok: true }),
    );

    const response = await app.inject({ method: 'POST', url: '/test-validation', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'REQUEST_VALIDATION_FAILED',
        message: 'Please correct the highlighted fields and try again',
        developerMessage:
          'One or more request fields failed schema validation. Inspect error.details.fields.',
        details: {
          fields: [{ field: 'body.email', message: 'This field is required', rule: 'required' }],
        },
        requestId: response.headers['x-request-id'],
      },
    });
    expect(response.body).not.toContain('schemaPath');
  });

  it('hides unexpected exception details from clients and logs them with the request ID', async () => {
    const logs: string[] = [];
    app = await buildApp({
      exposeDocs: false,
      logger: { level: 'error', stream: logStream(logs) },
    });
    app.get('/test-unhandled-error', async () => {
      throw new Error('private database diagnostic');
    });

    const response = await app.inject({ method: 'GET', url: '/test-unhandled-error' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong. Please try again later',
        developerMessage:
          'An unexpected server-side error occurred. Use requestId to locate the server log.',
        requestId: response.headers['x-request-id'],
      },
    });
    expect(response.body).not.toContain('private database diagnostic');
    expect(logs.join('')).toContain('private database diagnostic');
    expect(logs.join('')).toContain('INTERNAL_SERVER_ERROR');
    expect(logs.join('')).toContain(response.headers['x-request-id']);
  });

  it('logs application 5xx errors with their safe code and underlying cause', async () => {
    const logs: string[] = [];
    app = await buildApp({
      exposeDocs: false,
      logger: { level: 'error', stream: logStream(logs) },
    });
    app.get('/test-app-error', async () => {
      throw new AppError({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required service is temporarily unavailable',
        developerMessage: 'The test dependency could not complete the operation.',
        statusCode: 503,
        cause: new Error('private dependency diagnostic'),
      });
    });

    const response = await app.inject({ method: 'GET', url: '/test-app-error' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required service is temporarily unavailable',
        developerMessage: 'The test dependency could not complete the operation.',
        requestId: response.headers['x-request-id'],
      },
    });
    expect(response.body).not.toContain('private dependency diagnostic');
    expect(logs.join('')).toContain('DEPENDENCY_UNAVAILABLE');
    expect(logs.join('')).toContain('private dependency diagnostic');
    expect(logs.join('')).toContain(response.headers['x-request-id']);
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
    expect(document.paths['/health/live'].get.responses['503']).toBeTruthy();
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

function logStream(lines: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
}
