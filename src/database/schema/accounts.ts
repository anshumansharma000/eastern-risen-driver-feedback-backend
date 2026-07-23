import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accountRole, lifecycleStatus } from './enums.js';

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: accountRole('role').notNull(),
    displayName: text('display_name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: lifecycleStatus('status').notNull().default('ACTIVE'),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('auth_accounts_email_unique').on(sql`lower(${table.email})`),
    index('auth_accounts_status_idx').on(table.status),
    check(
      'auth_accounts_archived_at_check',
      sql`(${table.status} = 'ARCHIVED' AND ${table.archivedAt} IS NOT NULL)
          OR (${table.status} <> 'ARCHIVED' AND ${table.archivedAt} IS NULL)`,
    ),
  ],
);
