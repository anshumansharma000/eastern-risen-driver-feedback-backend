import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { lifecycleStatus } from './enums.js';

export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    status: lifecycleStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('vendors_active_name_unique')
      .on(sql`lower(${table.name})`)
      .where(sql`${table.status} <> 'ARCHIVED'`),
    index('vendors_status_idx').on(table.status),
    check(
      'vendors_archived_at_check',
      sql`(${table.status} = 'ARCHIVED' AND ${table.archivedAt} IS NOT NULL)
          OR (${table.status} <> 'ARCHIVED' AND ${table.archivedAt} IS NULL)`,
    ),
  ],
);
