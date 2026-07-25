import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const agencySettings = pgTable(
  'agency_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    singletonKey: boolean('singleton_key').notNull().default(true),
    agencyName: text('agency_name').notNull(),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    defaultThankYouMessage: text('default_thank_you_message').notNull(),
    negativeFeedbackThreshold: doublePrecision('negative_feedback_threshold'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('agency_settings_singleton_unique').on(table.singletonKey),
    check('agency_settings_singleton_check', sql`${table.singletonKey} = true`),
    check(
      'agency_settings_negative_threshold_check',
      sql`${table.negativeFeedbackThreshold} IS NULL
          OR ${table.negativeFeedbackThreshold} BETWEEN 1 AND 5`,
    ),
  ],
);
