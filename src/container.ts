import type { AppConfig } from './config/env.js';
import type { AppDatabase } from './database/client.js';
import { AnalyticsService } from './modules/analytics/analytics.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { DrizzleAuthRepository } from './modules/auth/auth.repository.js';
import { createAuthGuards, type AuthGuards } from './modules/auth/auth.guard.js';
import { passwordHasher } from './modules/auth/password.js';
import { DriverService } from './modules/drivers/driver.service.js';
import { FeedbackService } from './modules/feedback/feedback.service.js';
import { AdminFeedbackService } from './modules/feedback/admin-feedback.service.js';
import { QuestionnaireService } from './modules/questionnaires/questionnaire.service.js';
import { ProfileService } from './modules/profiles/profile.service.js';
import { SettingsService } from './modules/settings/settings.service.js';
import { TripService } from './modules/trips/trip.service.js';
import { VehicleService } from './modules/vehicles/vehicle.service.js';
import { VendorService } from './modules/vendors/vendor.service.js';
import { createFieldEncryptor } from './shared/security/field-encryption.js';

export interface ApplicationServices {
  readonly authService: AuthService;
  readonly profileService: ProfileService;
  readonly analyticsService: AnalyticsService;
  readonly adminFeedbackService: AdminFeedbackService;
  readonly guards: AuthGuards;
  readonly driverService: DriverService;
  readonly feedbackService: FeedbackService;
  readonly questionnaireService: QuestionnaireService;
  readonly settingsService: SettingsService;
  readonly tripService: TripService;
  readonly vehicleService: VehicleService;
  readonly vendorService: VendorService;
  readonly cookieName: string;
  readonly secureCookie: boolean;
}

export function createApplicationServices(db: AppDatabase, config: AppConfig): ApplicationServices {
  const authService = new AuthService(new DrizzleAuthRepository(db), passwordHasher, {
    idleTtlHours: config.sessionIdleTtlHours,
    absoluteTtlDays: config.sessionAbsoluteTtlDays,
    rotationIntervalHours: config.sessionRotationIntervalHours,
    rotationGraceSeconds: config.sessionRotationGraceSeconds,
  });
  const secureCookie = config.nodeEnv === 'production';
  const questionnaireService = new QuestionnaireService(db);
  const settingsService = new SettingsService(db);
  const encryptor = createFieldEncryptor(config.dataEncryptionKey);
  const feedbackService = new FeedbackService(
    db,
    questionnaireService,
    settingsService,
    encryptor,
    config.feedbackHandoffTtlHours,
  );
  return {
    analyticsService: new AnalyticsService(db, settingsService),
    adminFeedbackService: new AdminFeedbackService(db, encryptor, settingsService),
    authService,
    profileService: new ProfileService(db, passwordHasher),
    guards: createAuthGuards(authService, config.sessionCookieName, secureCookie),
    driverService: new DriverService(db, passwordHasher),
    feedbackService,
    questionnaireService,
    settingsService,
    tripService: new TripService(db),
    vehicleService: new VehicleService(db),
    vendorService: new VendorService(db),
    cookieName: config.sessionCookieName,
    secureCookie,
  };
}
