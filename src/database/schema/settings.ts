import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const agencySettings = pgTable(
  'agency_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    singletonKey: boolean('singleton_key').notNull().default(true),
    agencyName: text('agency_name').notNull(),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    defaultThankYouMessage: text('default_thank_you_message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('agency_settings_singleton_unique').on(table.singletonKey),
    check('agency_settings_singleton_check', sql`${table.singletonKey} = true`),
  ],
);
