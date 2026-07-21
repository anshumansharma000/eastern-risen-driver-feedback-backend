import { describe, expect, it, vi } from 'vitest';
import { AuthService, hashToken } from './auth.service.js';
import type { AuthRepository } from './auth.repository.js';
import type { AuthAccount, AuthPrincipal } from './auth.types.js';
import type { PasswordHasher } from './password.js';

const activeAdmin: AuthAccount = {
  accountId: '00000000-0000-4000-8000-000000000001',
  role: 'ADMIN',
  status: 'ACTIVE',
  displayName: 'Admin User',
  passwordHash: 'encoded-hash',
  passwordChangedAt: new Date('2026-01-01T00:00:00.000Z'),
  driverId: null,
};

function createRepository(account: AuthAccount | null = activeAdmin): AuthRepository {
  return {
    findAdminByEmail: vi.fn().mockResolvedValue(account),
    findDriverByCode: vi.fn().mockResolvedValue(account),
    createSession: vi.fn().mockResolvedValue(undefined),
    findPrincipalBySessionHash: vi.fn().mockResolvedValue(null),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    recordSuccessfulLogin: vi.fn().mockResolvedValue(undefined),
  };
}

function createPasswordHasher(valid = true): PasswordHasher {
  return {
    hash: vi.fn().mockResolvedValue('encoded-hash'),
    verify: vi.fn().mockResolvedValue(valid),
    performDummyVerification: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AuthService', () => {
  const now = new Date('2026-07-21T00:00:00.000Z');

  it('creates a hashed, expiring session after valid credentials', async () => {
    const repository = createRepository();
    const service = new AuthService(repository, createPasswordHasher(), {
      sessionTtlHours: 12,
      now: () => now,
    });

    const session = await service.loginAdmin(' ADMIN@EXAMPLE.COM ', 'correct-password');

    expect(session.principal).toMatchObject({ accountId: activeAdmin.accountId, role: 'ADMIN' });
    expect(session.expiresAt.toISOString()).toBe('2026-07-21T12:00:00.000Z');
    expect(session.token).toHaveLength(43);
    expect(repository.createSession).toHaveBeenCalledWith(
      activeAdmin.accountId,
      hashToken(session.token),
      session.expiresAt,
    );
    expect(repository.findAdminByEmail).toHaveBeenCalledWith('admin@example.com');
  });

  it('performs dummy password work for an unknown account', async () => {
    const repository = createRepository(null);
    const passwords = createPasswordHasher();
    const service = new AuthService(repository, passwords, { sessionTtlHours: 12 });

    await expect(service.loginAdmin('missing@example.com', 'password')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(passwords.performDummyVerification).toHaveBeenCalledWith('password');
    expect(repository.createSession).not.toHaveBeenCalled();
  });

  it('does not create a session for a deactivated account', async () => {
    const repository = createRepository({ ...activeAdmin, status: 'DEACTIVATED' });
    const service = new AuthService(repository, createPasswordHasher(), { sessionTtlHours: 12 });

    await expect(service.loginAdmin('admin@example.com', 'password')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(repository.createSession).not.toHaveBeenCalled();
  });

  it('resolves and revokes sessions by token hash', async () => {
    const repository = createRepository();
    const principal: AuthPrincipal = {
      accountId: activeAdmin.accountId,
      role: 'ADMIN',
      displayName: activeAdmin.displayName,
      driverId: null,
    };
    vi.mocked(repository.findPrincipalBySessionHash).mockResolvedValue(principal);
    const service = new AuthService(repository, createPasswordHasher(), {
      sessionTtlHours: 12,
      now: () => now,
    });

    await expect(service.resolveSession('raw-token')).resolves.toEqual(principal);
    await service.logout('raw-token');

    expect(repository.findPrincipalBySessionHash).toHaveBeenCalledWith(hashToken('raw-token'), now);
    expect(repository.revokeSession).toHaveBeenCalledWith(hashToken('raw-token'), now);
  });
});
