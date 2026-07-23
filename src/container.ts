import type { AppConfig } from './config/env.js';
import type { AppDatabase } from './database/client.js';
import { AuthService } from './modules/auth/auth.service.js';
import { DrizzleAuthRepository } from './modules/auth/auth.repository.js';
import { createAuthGuards, type AuthGuards } from './modules/auth/auth.guard.js';
import { passwordHasher } from './modules/auth/password.js';
import { DriverService } from './modules/drivers/driver.service.js';
import { FeedbackService } from './modules/feedback/feedback.service.js';
import { QuestionnaireService } from './modules/questionnaires/questionnaire.service.js';
import { TripService } from './modules/trips/trip.service.js';
import { VehicleService } from './modules/vehicles/vehicle.service.js';
import { VendorService } from './modules/vendors/vendor.service.js';
import { createFieldEncryptor } from './shared/security/field-encryption.js';

export interface ApplicationServices {
  readonly authService: AuthService;
  readonly guards: AuthGuards;
  readonly driverService: DriverService;
  readonly feedbackService: FeedbackService;
  readonly questionnaireService: QuestionnaireService;
  readonly tripService: TripService;
  readonly vehicleService: VehicleService;
  readonly vendorService: VendorService;
  readonly cookieName: string;
  readonly secureCookie: boolean;
  readonly cookieMaxAgeSeconds: number;
}

export function createApplicationServices(db: AppDatabase, config: AppConfig): ApplicationServices {
  const authService = new AuthService(new DrizzleAuthRepository(db), passwordHasher, {
    sessionTtlHours: config.sessionTtlHours,
  });
  const questionnaireService = new QuestionnaireService(db);
  const feedbackService = new FeedbackService(
    db,
    questionnaireService,
    createFieldEncryptor(config.dataEncryptionKey),
    config.feedbackHandoffTtlHours,
  );

  return {
    authService,
    guards: createAuthGuards(authService, config.sessionCookieName),
    driverService: new DriverService(db, passwordHasher),
    feedbackService,
    questionnaireService,
    tripService: new TripService(db),
    vehicleService: new VehicleService(db),
    vendorService: new VendorService(db),
    cookieName: config.sessionCookieName,
    secureCookie: config.nodeEnv === 'production',
    cookieMaxAgeSeconds: config.sessionTtlHours * 60 * 60,
  };
}
