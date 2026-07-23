import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
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
  feedbackReviewState,
  feedbackSubmissionMode,
  questionCategory,
  questionType,
} from './enums.js';
import { consentVersions, questionnaireVersions, versionQuestions } from './questionnaires.js';
import { trips } from './trips.js';
import { vendors } from './vendors.js';

export const feedbackHandoffs = pgTable(
  'feedback_handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .unique()
      .references(() => trips.id, { onDelete: 'cascade' }),
    questionnaireVersionId: uuid('questionnaire_version_id')
      .notNull()
      .references(() => questionnaireVersions.id, { onDelete: 'restrict' }),
    consentVersionId: uuid('consent_version_id')
      .notNull()
      .references(() => consentVersions.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    tokenCiphertext: text('token_ciphertext').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('feedback_handoffs_token_hash_unique').on(table.tokenHash),
    index('feedback_handoffs_expiry_idx').on(table.expiresAt),
  ],
);

export const feedbackSubmissions = pgTable(
  'feedback_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientSubmissionId: uuid('client_submission_id').notNull(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'restrict' }),
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
    respondentEmailCiphertext: text('respondent_email_ciphertext').notNull(),
    respondentBookingReference: text('respondent_booking_reference').notNull(),
    consentVersionId: uuid('consent_version_id')
      .notNull()
      .references(() => consentVersions.id, { onDelete: 'restrict' }),
    consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
    questionnaireVersionId: uuid('questionnaire_version_id')
      .notNull()
      .references(() => questionnaireVersions.id, { onDelete: 'restrict' }),
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
    uniqueIndex('feedback_submissions_trip_unique').on(table.tripId),
    index('feedback_submissions_driver_received_idx').on(table.driverId, table.receivedAt),
    index('feedback_submissions_review_received_idx').on(
      table.currentReviewState,
      table.receivedAt,
    ),
    check(
      'feedback_submissions_archive_state_check',
      sql`(${table.currentReviewState} = 'ARCHIVED' AND ${table.archivedAt} IS NOT NULL)
          OR (${table.currentReviewState} <> 'ARCHIVED' AND ${table.archivedAt} IS NULL)`,
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
  ],
);
