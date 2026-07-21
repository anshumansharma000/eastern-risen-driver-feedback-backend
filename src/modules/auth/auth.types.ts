export type AccountRole = 'ADMIN' | 'DRIVER';
export type AccountStatus = 'ACTIVE' | 'DEACTIVATED' | 'ARCHIVED';

export interface AuthAccount {
  readonly accountId: string;
  readonly role: AccountRole;
  readonly status: AccountStatus;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly passwordChangedAt: Date;
  readonly driverId: string | null;
}

export interface AuthPrincipal {
  readonly accountId: string;
  readonly role: AccountRole;
  readonly displayName: string;
  readonly driverId: string | null;
}

export interface AuthenticatedSession {
  readonly token: string;
  readonly principal: AuthPrincipal;
  readonly expiresAt: Date;
}
