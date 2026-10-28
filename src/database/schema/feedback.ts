import { sql } from 'drizzle-orm';
import {
  check,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authAccounts } from './accounts.js';
import { drivers } from './drivers.js';
import {
  driverSourceType,
  feedbackReviewAction,
  feedbackPhotoStatus,
  feedbackReviewState,
  feedbackSubmissionMode,
  questionnairePurpose,
  questionCategory,
  questionType,
} from './enums.js';
import { consentVersions, questionnaireVersions, versionQuestions } from './questionnaires.js';
import { bookingDriverEngagements } from './trips.js';
import { vendors } from './vendors.js';

export const feedbackHandoffs = pgTable(
  'feedback_handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engagementId: uuid('engagement_id')
      .notNull()
      .unique()
      .references(() => bookingDriverEngagements.id, { onDelete: 'cascade' }),
    questionnaireVersionId: uuid('questionnaire_version_id').references(
      () => questionnaireVersions.id,
      { onDelete: 'restrict' },
    ),
    consentVersionId: uuid('consent_version_id')
      .notNull()
      .references(() => consentVersions.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    tokenCiphertext: text('token_ciphertext').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    allowMultipleSubmissions: boolean('allow_multiple_submissions').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('feedback_handoffs_token_hash_unique').on(table.tokenHash),
    index('feedback_handoffs_expiry_idx').on(table.expiresAt),
  ],
);

export const feedbackHandoffSections = pgTable(
  'feedback_handoff_sections',
  {
    handoffId: uuid('handoff_id')
      .notNull()
      .references(() => feedbackHandoffs.id, { onDelete: 'cascade' }),
    purpose: questionnairePurpose('purpose').notNull(),
    questionnaireVersionId: uuid('questionnaire_version_id')
      .notNull()
      .references(() => questionnaireVersions.id, { onDelete: 'restrict' }),
    displayOrder: integer('display_order').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'feedback_handoff_sections_handoff_purpose_pk',
      columns: [table.handoffId, table.purpose],
    }),
    unique('feedback_handoff_sections_handoff_order_unique').on(
      table.handoffId,
      table.displayOrder,
    ),
  ],
);

export const feedbackSubmissions = pgTable(
  'feedback_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientSubmissionId: uuid('client_submission_id').notNull(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => bookingDriverEngagements.id, { onDelete: 'restrict' }),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'restrict' }),
    driverNameSnapshot: text('driver_name_snapshot').notNull(),
    driverSourceSnapshot: driverSourceType('driver_source_snapshot').notNull(),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    vendorNameSnapshot: text('vendor_name_snapshot'),
    bookingReferenceSnapshot: text('booking_reference_snapshot').notNull(),
    respondentName: text('respondent_name').notNull(),
    respondentPhoneCiphertext: text('respondent_phone_ciphertext').notNull(),
    // Legacy single-response submissions have no fingerprint. New responses always do.
    respondentPhoneHash: text('respondent_phone_hash'),
    allowMultipleSubmissions: boolean('allow_multiple_submissions').notNull().default(false),
    respondentEmailCiphertext: text('respondent_email_ciphertext').notNull(),
    respondentBookingReference: text('respondent_booking_reference').notNull(),
    consentVersionId: uuid('consent_version_id')
      .notNull()
      .references(() => consentVersions.id, { onDelete: 'restrict' }),
    consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
    questionnaireVersionId: uuid('questionnaire_version_id').references(
      () => questionnaireVersions.id,
      { onDelete: 'restrict' },
    ),
    questionnaireSnapshot: jsonb('questionnaire_snapshot')
      .$type<Record<string, unknown>>()
      .notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    submissionMode: feedbackSubmissionMode('submission_mode').notNull(),
    currentReviewState: feedbackReviewState('current_review_state').notNull().default('NORMAL'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedByAccountId: uuid('archived_by_account_id').references(() => authAccounts.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('feedback_submissions_client_id_unique').on(table.clientSubmissionId),
    uniqueIndex('feedback_submissions_single_engagement_unique')
      .on(table.engagementId)
      .where(sql`${table.allowMultipleSubmissions} = false`),
    uniqueIndex('feedback_submissions_engagement_phone_unique')
      .on(table.engagementId, table.respondentPhoneHash)
      .where(sql`${table.respondentPhoneHash} is not null`),
    index('feedback_submissions_driver_received_idx').on(table.driverId, table.receivedAt),
    index('feedback_submissions_review_received_idx').on(
      table.currentReviewState,
      table.receivedAt,
    ),
    check(
      'feedback_submissions_group_phone_required',
      sql`${table.allowMultipleSubmissions} = false OR ${table.respondentPhoneHash} IS NOT NULL`,
    ),
    check(
      'feedback_submissions_archive_state_check',
      sql`(${table.currentReviewState} = 'ARCHIVED' AND ${table.archivedAt} IS NOT NULL)
          OR (${table.currentReviewState} <> 'ARCHIVED' AND ${table.archivedAt} IS NULL)`,
    ),
  ],
);

export const feedbackSubmissionSections = pgTable(
  'feedback_submission_sections',
  {
    feedbackSubmissionId: uuid('feedback_submission_id')
      .notNull()
      .references(() => feedbackSubmissions.id, { onDelete: 'restrict' }),
    purpose: questionnairePurpose('purpose').notNull(),
    questionnaireVersionId: uuid('questionnaire_version_id')
      .notNull()
      .references(() => questionnaireVersions.id, { onDelete: 'restrict' }),
    questionnaireSnapshot: jsonb('questionnaire_snapshot')
      .$type<Record<string, unknown>>()
      .notNull(),
    displayOrder: integer('display_order').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'feedback_submission_sections_submission_purpose_pk',
      columns: [table.feedbackSubmissionId, table.purpose],
    }),
    unique('feedback_submission_sections_submission_order_unique').on(
      table.feedbackSubmissionId,
      table.displayOrder,
    ),
  ],
);

export const feedbackAnswers = pgTable(
  'feedback_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    feedbackSubmissionId: uuid('feedback_submission_id')
      .notNull()
      .references(() => feedbackSubmissions.id, { onDelete: 'restrict' }),
    versionQuestionId: uuid('version_question_id')
      .notNull()
      .references(() => versionQuestions.id, { onDelete: 'restrict' }),
    questionStableKey: text('question_stable_key').notNull(),
    questionPromptSnapshot: text('question_prompt_snapshot').notNull(),
    questionTypeSnapshot: questionType('question_type_snapshot').notNull(),
    categorySnapshot: questionCategory('category_snapshot').notNull(),
    questionnairePurposeSnapshot: questionnairePurpose('questionnaire_purpose_snapshot')
      .notNull()
      .default('DRIVER_FEEDBACK'),
    displayOrderSnapshot: integer('display_order_snapshot').notNull(),
    answerPayload: jsonb('answer_payload').$type<Record<string, unknown>>().notNull(),
    numericScore: doublePrecision('numeric_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('feedback_answers_submission_question_unique').on(
      table.feedbackSubmissionId,
      table.versionQuestionId,
    ),
    index('feedback_answers_submission_order_idx').on(
      table.feedbackSubmissionId,
      table.displayOrderSnapshot,
    ),
    index('feedback_answers_category_score_idx').on(table.categorySnapshot, table.numericScore),
  ],
);

export const feedbackPhotos = pgTable(
  'feedback_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => bookingDriverEngagements.id, { onDelete: 'restrict' }),
    feedbackSubmissionId: uuid('feedback_submission_id').references(() => feedbackSubmissions.id, {
      onDelete: 'restrict',
    }),
    uploadObjectKey: text('upload_object_key').notNull(),
    objectKey: text('object_key').notNull(),
    status: feedbackPhotoStatus('status').notNull().default('PENDING'),
    declaredContentType: text('declared_content_type').notNull(),
    storedContentType: text('stored_content_type'),
    byteSize: integer('byte_size'),
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }).notNull(),
    temporaryObjectCleanedAt: timestamp('temporary_object_cleaned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    attachedAt: timestamp('attached_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('feedback_photos_upload_object_key_unique').on(table.uploadObjectKey),
    uniqueIndex('feedback_photos_object_key_unique').on(table.objectKey),
    uniqueIndex('feedback_photos_submission_unique').on(table.feedbackSubmissionId),
    index('feedback_photos_engagement_status_idx').on(table.engagementId, table.status),
    index('feedback_photos_status_created_idx').on(table.status, table.createdAt),
    index('feedback_photos_upload_cleanup_idx').on(
      table.uploadExpiresAt,
      table.temporaryObjectCleanedAt,
    ),
    check(
      'feedback_photos_state_check',
      sql`(${table.status} IN ('PENDING', 'PROCESSING') AND ${table.completedAt} IS NULL AND ${table.attachedAt} IS NULL AND ${table.feedbackSubmissionId} IS NULL)
          OR (${table.status} = 'READY' AND ${table.completedAt} IS NOT NULL AND ${table.attachedAt} IS NULL AND ${table.feedbackSubmissionId} IS NULL)
          OR (${table.status} = 'ATTACHED' AND ${table.completedAt} IS NOT NULL AND ${table.attachedAt} IS NOT NULL AND ${table.feedbackSubmissionId} IS NOT NULL)
          OR (${table.status} = 'REJECTED' AND ${table.attachedAt} IS NULL AND ${table.feedbackSubmissionId} IS NULL)`,
    ),
  ],
);

export const feedbackReviewEvents = pgTable(
  'feedback_review_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    feedbackSubmissionId: uuid('feedback_submission_id')
      .notNull()
      .references(() => feedbackSubmissions.id, { onDelete: 'restrict' }),
    action: feedbackReviewAction('action').notNull(),
    reason: text('reason'),
    performedByAccountId: uuid('performed_by_account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('feedback_review_events_submission_created_idx').on(
      table.feedbackSubmissionId,
      table.createdAt,
    ),
  ],
);
