import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authAccounts } from './accounts.js';
import { bookingStatus } from './enums.js';

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingReference: text('booking_reference').notNull(),
    tourName: text('tour_name'),
    fileNumber: text('file_number'),
    passengerName: text('passenger_name').notNull(),
    passengerPhoneCiphertext: text('passenger_phone_ciphertext'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: bookingStatus('status').notNull().default('ACTIVE'),
    notes: text('notes'),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('bookings_reference_unique').on(sql`lower(${table.bookingReference})`),
    index('bookings_status_starts_idx').on(table.status, table.startsAt),
    check('bookings_period_check', sql`${table.endsAt} > ${table.startsAt}`),
    check(
      'bookings_archived_at_check',
      sql`(${table.status} = 'ARCHIVED' AND ${table.archivedAt} IS NOT NULL)
          OR (${table.status} <> 'ARCHIVED' AND ${table.archivedAt} IS NULL)`,
    ),
  ],
);
