import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authAccounts } from './accounts.js';
import { driverSourceType } from './enums.js';
import { vendors } from './vendors.js';

export const drivers = pgTable(
  'drivers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .unique()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    driverCode: text('driver_code').notNull(),
    phone: text('phone'),
    sourceType: driverSourceType('source_type').notNull(),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('drivers_code_unique').on(sql`lower(${table.driverCode})`),
    index('drivers_source_vendor_idx').on(table.sourceType, table.vendorId),
    check(
      'drivers_source_vendor_check',
      sql`(${table.sourceType} = 'OUTSOURCED' AND ${table.vendorId} IS NOT NULL)
          OR (${table.sourceType} = 'AGENCY' AND ${table.vendorId} IS NULL)`,
    ),
  ],
);
