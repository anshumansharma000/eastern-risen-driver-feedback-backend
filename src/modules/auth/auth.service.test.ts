import { describe, expect, it, vi } from 'vitest';
import { AuthService, hashToken } from './auth.service.js';
import type { AuthRepository } from './auth.repository.js';
import type { AuthAccount, ResolvedAuthSession } from './auth.types.js';
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
    findSessionByTokenHash: vi.fn().mockResolvedValue(null),
    rotateSession: vi.fn().mockResolvedValue(false),
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
  const options = {
    idleTtlHours: 72,
    absoluteTtlDays: 30,
    rotationIntervalHours: 24,
    rotationGraceSeconds: 60,
  };

  it('creates a hashed, expiring session after valid credentials', async () => {
    const repository = createRepository();
    const service = new AuthService(repository, createPasswordHasher(), {
      ...options,
      now: () => now,
    });

    const session = await service.loginAdmin(' ADMIN@EXAMPLE.COM ', 'correct-password');

    expect(session.principal).toMatchObject({ accountId: activeAdmin.accountId, role: 'ADMIN' });
    expect(session.expiresAt.toISOString()).toBe('2026-07-24T00:00:00.000Z');
    expect(session.token).toHaveLength(43);
    expect(repository.createSession).toHaveBeenCalledWith(
      activeAdmin.accountId,
      hashToken(session.token),
      session.expiresAt,
      new Date('2026-08-20T00:00:00.000Z'),
    );
    expect(repository.findAdminByEmail).toHaveBeenCalledWith('admin@example.com');
  });

  it('performs dummy password work for an unknown account', async () => {
    const repository = createRepository(null);
    const passwords = createPasswordHasher();
    const service = new AuthService(repository, passwords, options);

    await expect(service.loginAdmin('missing@example.com', 'password')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(passwords.performDummyVerification).toHaveBeenCalledWith('password');
    expect(repository.createSession).not.toHaveBeenCalled();
  });

  it('does not create a session for a deactivated account', async () => {
    const repository = createRepository({ ...activeAdmin, status: 'DEACTIVATED' });
    const service = new AuthService(repository, createPasswordHasher(), options);

    await expect(service.loginAdmin('admin@example.com', 'password')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(repository.createSession).not.toHaveBeenCalled();
  });

  it('resolves and revokes sessions by token hash', async () => {
    const repository = createRepository();
    const principal = {
      accountId: activeAdmin.accountId,
      role: 'ADMIN',
      displayName: activeAdmin.displayName,
      driverId: null,
    } as const;
    const session: ResolvedAuthSession = {
      id: '00000000-0000-4000-8000-000000000002',
      principal,
      tokenHash: hashToken('raw-token'),
      matchedCurrentToken: true,
      expiresAt: new Date('2026-07-21T12:00:00.000Z'),
      absoluteExpiresAt: new Date('2026-08-20T00:00:00.000Z'),
      rotatedAt: now,
    };
    vi.mocked(repository.findSessionByTokenHash).mockResolvedValue(session);
    const service = new AuthService(repository, createPasswordHasher(), {
      ...options,
      now: () => now,
    });

    await expect(service.resolveSession('raw-token')).resolves.toEqual({ principal });
    await service.logout('raw-token');

    expect(repository.findSessionByTokenHash).toHaveBeenCalledWith(hashToken('raw-token'), now);
    expect(repository.revokeSession).toHaveBeenCalledWith(hashToken('raw-token'), now);
  });

  it('rotates and renews an active session after the rotation interval', async () => {
    const repository = createRepository();
    const currentToken = 'current-token';
    const principal = {
      accountId: activeAdmin.accountId,
      role: 'ADMIN',
      displayName: activeAdmin.displayName,
      driverId: null,
    } as const;
    vi.mocked(repository.findSessionByTokenHash).mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      principal,
      tokenHash: hashToken(currentToken),
      matchedCurrentToken: true,
      expiresAt: new Date('2026-07-21T04:00:00.000Z'),
      absoluteExpiresAt: new Date('2026-08-20T00:00:00.000Z'),
      rotatedAt: new Date('2026-07-20T00:00:00.000Z'),
    });
    vi.mocked(repository.rotateSession).mockResolvedValue(true);
    const service = new AuthService(repository, createPasswordHasher(), {
      ...options,
      now: () => now,
    });

    const resolution = await service.resolveSession(currentToken);

    expect(resolution.principal).toEqual(principal);
    expect(resolution.renewal?.token).toHaveLength(43);
    expect(resolution.renewal?.expiresAt.toISOString()).toBe('2026-07-24T00:00:00.000Z');
    expect(repository.rotateSession).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000002',
      hashToken(currentToken),
      hashToken(resolution.renewal!.token),
      resolution.renewal!.expiresAt,
      new Date('2026-07-21T00:01:00.000Z'),
      now,
    );
  });

  it('never renews a session beyond its 30-day absolute expiry', async () => {
    const repository = createRepository();
    const currentToken = 'current-token';
    vi.mocked(repository.findSessionByTokenHash).mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      principal: {
        accountId: activeAdmin.accountId,
        role: 'ADMIN',
        displayName: activeAdmin.displayName,
        driverId: null,
      },
      tokenHash: hashToken(currentToken),
      matchedCurrentToken: true,
      expiresAt: new Date('2026-07-21T01:00:00.000Z'),
      absoluteExpiresAt: new Date('2026-07-21T02:00:00.000Z'),
      rotatedAt: new Date('2026-07-20T00:00:00.000Z'),
    });
    vi.mocked(repository.rotateSession).mockResolvedValue(true);
    const service = new AuthService(repository, createPasswordHasher(), {
      ...options,
      now: () => now,
    });

    const resolution = await service.resolveSession(currentToken);

    expect(resolution.renewal?.expiresAt.toISOString()).toBe('2026-07-21T02:00:00.000Z');
  });
});
