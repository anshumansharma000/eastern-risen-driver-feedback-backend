import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../shared/errors/app-error.js';
import type { AuthRepository } from './auth.repository.js';
import type { AuthAccount, AuthenticatedSession, AuthPrincipal } from './auth.types.js';
import type { PasswordHasher } from './password.js';

export interface AuthServiceOptions {
  readonly sessionTtlHours: number;
  readonly now?: () => Date;
}

export class AuthService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordHasher,
    private readonly options: AuthServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async loginAdmin(email: string, password: string): Promise<AuthenticatedSession> {
    const account = await this.repository.findAdminByEmail(email.trim().toLowerCase());
    return this.authenticate(account, password);
  }

  async loginDriver(driverCode: string, password: string): Promise<AuthenticatedSession> {
    const account = await this.repository.findDriverByCode(driverCode.trim().toLowerCase());
    return this.authenticate(account, password);
  }

  async resolveSession(token: string | undefined): Promise<AuthPrincipal> {
    if (!token) throw this.unauthorized();

    const principal = await this.repository.findPrincipalBySessionHash(hashToken(token), this.now());
    if (!principal) throw this.unauthorized();
    return principal;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.repository.revokeSession(hashToken(token), this.now());
  }

  private async authenticate(
    account: AuthAccount | null,
    password: string,
  ): Promise<AuthenticatedSession> {
    if (!account) {
      await this.passwords.performDummyVerification(password);
      throw this.invalidCredentials();
    }

    const validPassword = await this.passwords.verify(account.passwordHash, password);
    if (!validPassword || account.status !== 'ACTIVE') throw this.invalidCredentials();

    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.options.sessionTtlHours * 60 * 60 * 1000);
    const token = randomBytes(32).toString('base64url');

    await this.repository.createSession(account.accountId, hashToken(token), expiresAt);
    await this.repository.recordSuccessfulLogin(account.accountId, now);

    return {
      token,
      expiresAt,
      principal: {
        accountId: account.accountId,
        role: account.role,
        displayName: account.displayName,
        driverId: account.driverId,
      },
    };
  }

  private invalidCredentials(): AppError {
    return new AppError({
      code: 'AUTHENTICATION_FAILED',
      message: 'The supplied credentials are invalid',
      statusCode: 401,
    });
  }

  private unauthorized(): AppError {
    return new AppError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid authenticated session is required',
      statusCode: 401,
    });
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
