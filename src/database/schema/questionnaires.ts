import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authAccounts } from './accounts.js';
import {
  questionCategory,
  questionnaireStatus,
  questionnaireVersionStatus,
  questionStatus,
  questionType,
} from './enums.js';

export const consentVersions = pgTable(
  'consent_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('consent_versions_version_unique').on(table.version),
    uniqueIndex('consent_versions_active_unique')
      .on(sql`((1))`)
      .where(sql`${table.retiredAt} IS NULL`),
  ],
);

export const questionnaires = pgTable(
  'questionnaires',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    status: questionnaireStatus('status').notNull().default('ACTIVE'),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('questionnaires_status_idx').on(table.status),
    check(
      'questionnaires_archived_at_check',
      sql`(${table.status} = 'ARCHIVED' AND ${table.archivedAt} IS NOT NULL)
          OR (${table.status} = 'ACTIVE' AND ${table.archivedAt} IS NULL)`,
    ),
  ],
);

export const questionnaireVersions = pgTable(
  'questionnaire_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionnaireId: uuid('questionnaire_id')
      .notNull()
      .references(() => questionnaires.id, { onDelete: 'restrict' }),
    versionNumber: integer('version_number').notNull(),
    status: questionnaireVersionStatus('status').notNull().default('DRAFT'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('questionnaire_versions_number_unique').on(table.questionnaireId, table.versionNumber),
    uniqueIndex('questionnaire_versions_global_active_unique')
      .on(sql`((1))`)
      .where(sql`${table.status} = 'ACTIVE'`),
    index('questionnaire_versions_questionnaire_status_idx').on(
      table.questionnaireId,
      table.status,
    ),
  ],
);

export const versionQuestions = pgTable(
  'version_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionnaireVersionId: uuid('questionnaire_version_id')
      .notNull()
      .references(() => questionnaireVersions.id, { onDelete: 'cascade' }),
    stableKey: text('stable_key').notNull(),
    prompt: text('prompt').notNull(),
    questionType: questionType('question_type').notNull(),
    category: questionCategory('category').notNull(),
    status: questionStatus('status').notNull().default('ACTIVE'),
    isRequired: boolean('is_required').notNull().default(false),
    displayOrder: integer('display_order').notNull(),
    contributesToScore: boolean('contributes_to_score').notNull().default(false),
    scoreMin: doublePrecision('score_min'),
    scoreMax: doublePrecision('score_max'),
  },
  (table) => [
    unique('version_questions_stable_key_unique').on(table.questionnaireVersionId, table.stableKey),
    unique('version_questions_order_unique').on(table.questionnaireVersionId, table.displayOrder),
    check('version_questions_order_check', sql`${table.displayOrder} >= 0`),
    check(
      'version_questions_score_bounds_check',
      sql`${table.scoreMin} IS NULL OR ${table.scoreMax} IS NULL OR ${table.scoreMin} <= ${table.scoreMax}`,
    ),
    check(
      'version_questions_text_score_check',
      sql`${table.questionType} <> 'TEXT' OR ${table.contributesToScore} = false`,
    ),
  ],
);

export const questionOptions = pgTable(
  'question_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionQuestionId: uuid('version_question_id')
      .notNull()
      .references(() => versionQuestions.id, { onDelete: 'cascade' }),
    valueKey: text('value_key').notNull(),
    label: text('label').notNull(),
    scoreValue: doublePrecision('score_value'),
    displayOrder: integer('display_order').notNull(),
  },
  (table) => [
    unique('question_options_value_key_unique').on(table.versionQuestionId, table.valueKey),
    unique('question_options_order_unique').on(table.versionQuestionId, table.displayOrder),
    check('question_options_order_check', sql`${table.displayOrder} >= 0`),
  ],
);
