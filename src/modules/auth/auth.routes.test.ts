import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createAuthGuards } from './auth.guard.js';
import { authRoutes } from './auth.routes.js';
import type { AuthService } from './auth.service.js';

describe('core login request', () => {
  it.each(['core.admin', 'core.admin@example.com', `${'a'.repeat(64)}@${'b'.repeat(50)}.com`])(
    'accepts a username or email and returns a session cookie: %s',
    async (identifier) => {
      const loginCore = vi.fn().mockResolvedValue({
        token: 'session-token',
        expiresAt: new Date(Date.now() + 60_000),
        principal: {
          accountId: '00000000-0000-4000-8000-000000000001',
          role: 'CORE_ADMIN',
          displayName: 'Core Admin',
          driverId: null,
        },
      });
      const service = { loginCore } as unknown as AuthService;
      const app = Fastify();
      try {
        await app.register(cookie);
        await app.register(authRoutes, {
          authService: service,
          guards: createAuthGuards(service, 'session', false),
          cookieName: 'session',
          secureCookie: false,
        });

        const response = await app.inject({
          method: 'POST',
          url: '/core/login',
          payload: { username: identifier, password: 'correct-password' },
        });

        expect(response.statusCode, response.body).toBe(200);
        expect(loginCore).toHaveBeenCalledWith(identifier, 'correct-password');
        expect(response.headers['set-cookie']).toContain('session=session-token');
        expect(response.json<{ data: { user: { role: string } } }>().data.user.role).toBe(
          'CORE_ADMIN',
        );
      } finally {
        await app.close();
      }
    },
  );
});
