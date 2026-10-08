import { CustomerService } from './modules/customer/customer.service.js';
import { createSharedCatalogAdapter } from './shared/catalog/core-catalog.adapter.js';
import { createCoreServices, type CoreServices } from './modules/core/index.js';
import { CoreIdentityAdapter } from './modules/auth/core-identity.adapter.js';
import type { AppConfig } from './config/env.js';
import type { AppDatabase } from './database/client.js';
import { AnalyticsService } from './modules/analytics/analytics.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { BookingService } from './modules/bookings/booking.service.js';
import { DrizzleAuthRepository } from './modules/auth/auth.repository.js';
import { createAuthGuards, type AuthGuards } from './modules/auth/auth.guard.js';
import { passwordHasher } from './modules/auth/password.js';
import { DriverService } from './modules/drivers/driver.service.js';
import { EngagementService } from './modules/engagements/engagement.service.js';
import { FeedbackService } from './modules/feedback/feedback.service.js';
import { AdminFeedbackService } from './modules/feedback/admin-feedback.service.js';
import { QuestionnaireService } from './modules/questionnaires/questionnaire.service.js';
import { ProfileService } from './modules/profiles/profile.service.js';
import { SettingsService } from './modules/settings/settings.service.js';
import { TripService } from './modules/trips/trip.service.js';
import { VehicleService } from './modules/vehicles/vehicle.service.js';
import { VendorService } from './modules/vendors/vendor.service.js';
import { createFieldEncryptor } from './shared/security/field-encryption.js';
import { DisabledPhotoStorage, R2PhotoStorage } from './shared/storage/photo-storage.js';
import { CashfreeProvider } from './modules/core/integrations/cashfree.provider.js';

export interface ApplicationServices {
  readonly customerService: CustomerService;
  readonly customerCookieName: string;
  readonly core: CoreServices;
  readonly authService: AuthService;
  readonly bookingService: BookingService;
  readonly profileService: ProfileService;
  readonly analyticsService: AnalyticsService;
  readonly adminFeedbackService: AdminFeedbackService;
  readonly guards: AuthGuards;
  readonly driverService: DriverService;
  readonly engagementService: EngagementService;
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
  const photoStorage = config.r2 ? new R2PhotoStorage(config.r2) : new DisabledPhotoStorage();
  const tripService = new TripService(db);
  const engagementService = new EngagementService(db, tripService);
  const feedbackService = new FeedbackService(
    db,
    questionnaireService,
    settingsService,
    encryptor,
    config.feedbackHandoffTtlHours,
    config.passengerFeedbackUrl,
    photoStorage,
  );
  const guards = createAuthGuards(authService, config.sessionCookieName, secureCookie);
  const vendorService = new VendorService(db);
  const vehicleService = new VehicleService(db);
  const core = createCoreServices(
    db,
    new CoreIdentityAdapter(db, passwordHasher),
    createSharedCatalogAdapter(db, vendorService, vehicleService),
    guards.authenticated,
    config.cashfree
      ? new CashfreeProvider(
          config.cashfree.environment,
          config.cashfree.appId,
          config.cashfree.secretKey,
          config.cashfree.webhookUrl,
        )
      : null,
    config.paymentPendingReviewAfterHours,
  );
  return {
    customerService: new CustomerService(
      db,
      passwordHasher,
      core,
      encryptor,
      config.customerAccountUrl,
      !!config.customerMail,
    ),
    customerCookieName: `${config.sessionCookieName}_customer`,
    core,
    analyticsService: new AnalyticsService(db, settingsService),
    adminFeedbackService: new AdminFeedbackService(db, encryptor, settingsService, photoStorage),
    authService,
    bookingService: new BookingService(db, encryptor),
    profileService: new ProfileService(db, passwordHasher),
    guards,
    driverService: new DriverService(db, passwordHasher),
    engagementService,
    feedbackService,
    questionnaireService,
    settingsService,
    tripService,
    vehicleService,
    vendorService,
    cookieName: config.sessionCookieName,
    secureCookie,
  };
}
