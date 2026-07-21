import type { AppConfig } from './config/env.js';
import type { AppDatabase } from './database/client.js';
import { AuthService } from './modules/auth/auth.service.js';
import { DrizzleAuthRepository } from './modules/auth/auth.repository.js';
import { createAuthGuards, type AuthGuards } from './modules/auth/auth.guard.js';
import { passwordHasher } from './modules/auth/password.js';
import { DriverService } from './modules/drivers/driver.service.js';
import { VendorService } from './modules/vendors/vendor.service.js';

export interface ApplicationServices {
  readonly authService: AuthService;
  readonly guards: AuthGuards;
  readonly driverService: DriverService;
  readonly vendorService: VendorService;
  readonly cookieName: string;
  readonly secureCookie: boolean;
}

export function createApplicationServices(
  db: AppDatabase,
  config: AppConfig,
): ApplicationServices {
  const authService = new AuthService(new DrizzleAuthRepository(db), passwordHasher, {
    sessionTtlHours: config.sessionTtlHours,
  });

  return {
    authService,
    guards: createAuthGuards(authService, config.sessionCookieName),
    driverService: new DriverService(db, passwordHasher),
    vendorService: new VendorService(db),
    cookieName: config.sessionCookieName,
    secureCookie: config.nodeEnv === 'production',
  };
}
